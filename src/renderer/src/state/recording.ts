import { useSyncExternalStore } from 'react'
import type { TrackId } from '@core/model/types'
import { isNoteTrackKind } from '@core/model/types'
import { newId } from '@core/model/ids'
import { buildMidiTakeOp, type MidiTake } from '@core/ops/midiTake'
import { Recorder } from '@audio/recorder'
import type { InputHandle } from '@audio/backendTypes'
import { encodeWavPcm16Async } from '@audio/wav'
import { ticksPerSecond } from '@audio/scheduling'
import { applyMidiCaptureEvent, midiEventSec, type MidiNoteSink } from '@audio/midiCapture'
import { projectStore } from './projectStore'
import { transport } from './transport'
import { audioEngine, assetStore } from './audioInstance'
import { describeInputError, trackInputs } from './trackInputs'
import { midiInputs } from './midiInputs'
import { preferences } from './preferences'
import { latencyCalibration } from './latencyCalibration'

/**
 * Recording session state (all ephemeral, per-user): which tracks are
 * armed, whether capture is running, and the region being recorded.
 *
 * Each armed AUDIO track records its OWN input (device + channel selection
 * from trackInputs), so a multi-track take yields one asset per track
 * rather than the same audio duplicated everywhere. Devices are shared
 * across those inputs by the backend, not here. Armed MIDI tracks capture
 * note events instead (routed here by state/midiInputs) — no input, no
 * asset, just notes.
 *
 * On stop, every audio take becomes a normal asset + bay entry + clip, and
 * every MIDI take ONE clip/create with its notes (ONE clip/createMany when
 * several stop together) — so a recording reaches collaborators through
 * the exact same machinery as an imported file.
 */

/** One armed track's live capture rig. */
interface TrackCapture {
  trackId: TrackId
  recorder: Recorder
  input: InputHandle
}

/** One armed MIDI track's growing take (note math in audio/midiCapture). */
interface MidiCapture extends MidiNoteSink {
  trackId: TrackId
}

class RecordingStore {
  private armedTracks = new Set<TrackId>()
  recording = false
  /** The count-in is clicking; capture starts when it ends. */
  countingIn = false
  /** start() is between its guard and its outcome (awaiting resume /
   *  permission prompts / getUserMedia) — blocks re-entry synchronously. */
  private starting = false
  recordStartTicks = 0
  /** Context time paired with recordStartTicks — the roll's clock anchor. */
  private rollAnchorSec = 0
  lastError: string | null = null

  private captures: TrackCapture[] = []
  private midiCaptures = new Map<TrackId, MidiCapture>()
  /** ctx.currentTime − performance.now()/1000 at roll: maps Web MIDI
   *  event.timeStamp (performance timeline, ms) onto the audio clock. */
  private midiClockOffsetSec = 0
  private takeCounter = 1
  private countInTimer: number | null = null

  private version = 0
  private listeners = new Set<() => void>()

  constructor() {
    // Space (or any transport stop) ends the take like the record button
    // does — capture must never keep running invisibly after the
    // transport halts. A stop during the count-in cancels it.
    transport.onEvent((event) => {
      if (event === 'stop' && (this.recording || this.countingIn)) this.stop()
      // Playback started mid-count-in: waiting out the clicks is pointless.
      if (event === 'play' && this.countingIn) {
        if (this.countInTimer !== null) {
          clearTimeout(this.countInTimer)
          this.countInTimer = null
        }
        this.countingIn = false
        this.beginRoll()
      }
    })
  }

  isArmed(trackId: TrackId): boolean {
    return this.armedTracks.has(trackId)
  }

  get armedCount(): number {
    return this.armedTracks.size
  }

  armedIds(): TrackId[] {
    return [...this.armedTracks]
  }

  toggleArm(trackId: TrackId): void {
    if (!this.armedTracks.delete(trackId)) this.armedTracks.add(trackId)
    this.emit()
  }

  /** Start capture. `inputOverride` lets a test inject a synthetic input
   *  (one handle, so one armed track — real runs open one per track). */
  async start(inputOverride?: InputHandle): Promise<void> {
    // `starting` closes the window the awaits below leave open: a held or
    // double-pressed record key must not interleave a second run (which
    // would tear down the shared captures or duplicate every take).
    if (this.starting || this.recording || this.countingIn) return
    const state = projectStore.state
    const armed = this.armedIds().filter((id) => {
      const track = state.tracks[id]
      return (
        track !== undefined &&
        (track.kind === 'audio' || isNoteTrackKind(track.kind)) &&
        track.frozenAssetId === null
      )
    })
    const audioArmed = armed.filter((id) => state.tracks[id]?.kind === 'audio')
    if (armed.length === 0) {
      this.fail('Arm a track first (● on the track header)')
      return
    }
    this.starting = true
    try {
      await audioEngine.ensureStarted()

      // MIDI needs no input, only open access — up front so the browser's
      // permission prompt (plain Chrome) happens before the count-in, like
      // the capture permission below. Denied/unsupported still records via
      // inject().
      if (armed.length > audioArmed.length) await midiInputs.ensure()

      // Open inputs up front (permission prompts happen here), but hold
      // capture until the roll so a count-in never ends up in the take.
      for (const trackId of audioArmed) {
        const input =
          inputOverride ?? (await trackInputs.openFor(trackInputs.configOf(trackId)))
        this.captures.push({ trackId, recorder: new Recorder(), input })
      }

      // Count in only from a standing start — punching in while the song
      // already plays must stay immediate.
      const bars = transport.isPlaying ? 0 : preferences.countInBars
      if (bars > 0) {
        this.countingIn = true
        this.lastError = null
        const seconds = audioEngine.countInClicks(bars)
        this.countInTimer = window.setTimeout(() => {
          this.countInTimer = null
          this.countingIn = false
          this.beginRoll()
        }, seconds * 1000)
        this.emit()
      } else {
        this.beginRoll()
      }
    } catch (error) {
      this.teardownCaptures()
      this.fail(describeInputError(error))
    } finally {
      this.starting = false
    }
  }

  /** The count-in (if any) is over: capture and roll from here. */
  private beginRoll(): void {
    try {
      for (const capture of this.captures) {
        capture.recorder.start(capture.input)
      }
      // Fresh MIDI note sinks for every armed MIDI track, and the clock
      // anchor pair that places their events on the timeline.
      this.midiCaptures.clear()
      for (const trackId of this.armedIds()) {
        const track = projectStore.state.tracks[trackId]
        if (track !== undefined && isNoteTrackKind(track.kind) && track.frozenAssetId === null) {
          this.midiCaptures.set(trackId, { trackId, active: new Map(), closed: [] })
        }
      }
      const now = audioEngine.now()
      this.midiClockOffsetSec = now - performance.now() / 1000
      this.recordStartTicks = transport.positionTicks()
      this.rollAnchorSec = now
      this.recording = true
      this.lastError = null
      if (!transport.isPlaying) transport.play()
      this.emit()
    } catch (error) {
      this.teardownCaptures()
      this.fail(
        `Could not start recording: ${error instanceof Error ? error.message : String(error)}`
      )
    }
  }

  /**
   * One routed note event from state/midiInputs (hardware or inject()).
   * Ignored unless the roll is on and the track is armed for MIDI; note
   * bookkeeping (retrigger-close, orphan-drop, end clamping) lives in
   * audio/midiCapture. `timeStampMs` is on the performance timeline, like
   * MIDIMessageEvent.timeStamp.
   */
  captureMidiEvent(
    trackId: TrackId,
    kind: 'on' | 'off',
    pitch: number,
    velocity: number,
    timeStampMs: number
  ): void {
    if (!this.recording) return
    let capture = this.midiCaptures.get(trackId)
    if (!capture) {
      // Punch-in: a MIDI track armed after the roll began gets its sink on
      // its first event — the clock anchor already stands, so late sinks
      // land on the same timeline as the ones built at beginRoll.
      const track = projectStore.state.tracks[trackId]
      if (
        !this.armedTracks.has(trackId) ||
        track === undefined ||
        !isNoteTrackKind(track.kind) ||
        track.frozenAssetId !== null
      )
        return
      capture = { trackId, active: new Map(), closed: [] }
      this.midiCaptures.set(trackId, capture)
    }
    applyMidiCaptureEvent(
      capture,
      kind,
      pitch,
      velocity,
      midiEventSec(timeStampMs, this.midiClockOffsetSec)
    )
  }

  /** Release every capture rig; keeps no takes. */
  private teardownCaptures(): void {
    for (const capture of this.captures) capture.input.dispose()
    this.captures = []
    this.midiCaptures.clear()
  }

  /** Stop capture; every track's take becomes its own asset + bay entry + clip. */
  stop(): void {
    // During the count-in nothing is captured yet — just call it off.
    if (this.countingIn) {
      if (this.countInTimer !== null) {
        clearTimeout(this.countInTimer)
        this.countInTimer = null
      }
      this.countingIn = false
      this.teardownCaptures()
      this.emit()
      return
    }
    if (!this.recording) return
    this.recording = false
    const captures = this.captures
    this.captures = []
    // Inputs are NOT released here: each recorder's stop awaits the
    // backend's flush, and closing the device first would take the tail
    // of every take with it. finishTakes disposes them once they land.
    const takes = captures.map((capture) => ({ capture, take: capture.recorder.stop() }))
    this.emit()

    const stopSec = audioEngine.now()
    // MIDI takes are pure data — committed synchronously, right now.
    this.finishMidiTakes(stopSec, this.recordStartTicks, this.rollAnchorSec)
    // Audio takes finish asynchronously: the WAV encode is chunked so
    // hitting Stop after a long multitrack take never freezes the app at
    // the very moment the user is most anxious about whether it survived.
    void this.finishTakes(takes, this.recordStartTicks, this.rollAnchorSec)
  }

  /**
   * Commit captured MIDI: ONE clip/create per take, ONE clip/createMany
   * when several tracks stopped together, nothing for empty takes — the
   * op itself is built by the pure core helper (see core/ops/midiTake).
   * Compensation is the OUTPUT path only: the performer played along with
   * what they heard, which ran late by that much. The manual record trim
   * does NOT apply here — it calibrates the audio INPUT path (mic → OS
   * buffers → worklet), while Web MIDI timestamps are driver-stamped and
   * carry no such lag.
   */
  private finishMidiTakes(stopSec: number, anchorTicks: number, anchorSec: number): void {
    const captures = [...this.midiCaptures.values()]
    this.midiCaptures.clear()
    if (captures.length === 0) return
    const compensationSec = audioEngine.outputLatencySec()
    const tps = ticksPerSecond(projectStore.state.tempo)
    const toTicks = (sec: number): number =>
      Math.round(anchorTicks + (sec - anchorSec - compensationSec) * tps)
    const takes: MidiTake[] = captures.map((capture) => ({
      trackId: capture.trackId,
      startTicks: anchorTicks,
      endTicks: Math.max(anchorTicks + 1, toTicks(stopSec)),
      notes: [...capture.closed, ...capture.active.values()].map((note) => ({
        pitch: note.pitch,
        velocity: note.velocity,
        startTicks: toTicks(note.startSec),
        // null = still held at stop; the helper closes it at the take end.
        endTicks: note.endSec === null ? null : toTicks(note.endSec)
      }))
    }))
    const op = buildMidiTakeOp(projectStore.state, takes)
    if (op) projectStore.dispatch(op)
  }

  private async finishTakes(
    pending: Array<{ capture: TrackCapture; take: ReturnType<Recorder['stop']> }>,
    anchorTicks: number,
    anchorSec: number
  ): Promise<void> {
    const takes = await Promise.all(
      pending.map(async ({ capture, take }) => ({ capture, take: await take }))
    )
    // Every tail has landed — release the devices before the (chunked,
    // potentially long) encode, not after.
    for (const { capture } of takes) capture.input.dispose()

    // Latency compensation. The performer played along with audio they
    // heard an output-latency LATE, so everything they did sits late in
    // the take by that amount. The input path (mic → buffers → worklet) is
    // unreported by the platform: the measured loopback calibration covers
    // it when one exists for the current device setup, and the manual trim
    // rides on top (it is the whole input estimate only when unmeasured).
    const compensationSec =
      audioEngine.outputLatencySec() +
      (latencyCalibration.autoTrimSec() ?? 0) +
      preferences.recordLatencyTrimMs / 1000
    const tps = ticksPerSecond(projectStore.state.tempo)
    for (const { capture, take } of takes) {
      if (!take || take.seconds < 0.05) continue
      const track = projectStore.state.tracks[capture.trackId]
      if (!track || track.kind !== 'audio') continue
      // Place the take by where its FIRST SAMPLE actually sat on the audio
      // clock (announced by the backend's capture), not by when start()
      // was called — capture spin-up would otherwise land every take late.
      const skewSec = take.startSec !== null ? take.startSec - anchorSec : 0
      const startTicks = Math.max(0, Math.round(anchorTicks + (skewSec - compensationSec) * tps))

      const buffer = audioEngine.createBuffer(take.channels, take.sampleRate)
      const wav = await encodeWavPcm16Async(take.channels, take.sampleRate)

      const name = `Recording ${this.takeCounter++}.wav`
      const asset = assetStore.addAudio(name, 'wav', wav, buffer)
      const baseName = name.replace(/\.wav$/, '')

      projectStore.dispatch({
        type: 'file/create',
        nodes: [
          { id: newId('fil'), parentId: null, kind: 'audio', name: baseName, assetId: asset.id }
        ]
      })
      projectStore.dispatch({
        type: 'clip/create',
        clip: {
          id: newId('clp'),
          trackId: capture.trackId,
          name: baseName,
          start: startTicks,
          duration: Math.max(
            1,
            Math.round(take.seconds * ticksPerSecond(projectStore.state.tempo))
          ),
          assetId: asset.id,
          offset: 0,
          color: null,
          fadeIn: 0,
          fadeOut: 0,
          reverse: false,
          pitch: 0,
          stretch: 1,
          loopLength: 0
        },
        notes: []
      })
    }
  }

  async toggle(): Promise<void> {
    if (this.recording || this.countingIn) this.stop()
    else await this.start()
  }

  private fail(message: string): void {
    this.lastError = message
    this.emit()
    setTimeout(() => {
      if (this.lastError === message) {
        this.lastError = null
        this.emit()
      }
    }, 4000)
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getVersion = (): number => this.version

  private emit(): void {
    this.version++
    for (const listener of this.listeners) listener()
  }
}

export const recording = new RecordingStore()

export function useRecording(): RecordingStore {
  useSyncExternalStore(recording.subscribe, recording.getVersion)
  return recording
}
