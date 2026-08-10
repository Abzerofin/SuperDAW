import { useSyncExternalStore } from 'react'
import type { TrackId } from '@core/model/types'
import { newId } from '@core/model/ids'
import { Recorder } from '@audio/recorder'
import { buildInputTap, type InputTap } from '@audio/input'
import { encodeWavPcm16Async } from '@audio/wav'
import { ticksPerSecond } from '@audio/scheduling'
import { projectStore } from './projectStore'
import { transport } from './transport'
import { audioEngine, assetStore } from './audioInstance'
import { trackInputs } from './trackInputs'
import { preferences } from './preferences'

/**
 * Recording session state (all ephemeral, per-user): which tracks are
 * armed, whether capture is running, and the region being recorded.
 *
 * Each armed track records its OWN input (device + channel selection from
 * trackInputs), so a multi-track take yields one asset per track rather
 * than the same audio duplicated everywhere. Streams are shared and
 * reference-counted per device by the input store.
 *
 * On stop, every take becomes a normal asset + bay entry + clip through
 * ordinary ops — so a recording reaches collaborators through the exact
 * same machinery as an imported file.
 */

/** One armed track's live capture rig. */
interface TrackCapture {
  trackId: TrackId
  recorder: Recorder
  tap: InputTap
  deviceKey: string
}

class RecordingStore {
  private armedTracks = new Set<TrackId>()
  recording = false
  /** The count-in is clicking; capture starts when it ends. */
  countingIn = false
  recordStartTicks = 0
  /** Context time paired with recordStartTicks — the roll's clock anchor. */
  private rollAnchorSec = 0
  lastError: string | null = null

  private captures: TrackCapture[] = []
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
        void this.beginRoll(audioEngine.ensureContext())
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

  /** Start capture. `streamOverride` lets tests inject a synthetic stream. */
  async start(streamOverride?: MediaStream): Promise<void> {
    if (this.recording || this.countingIn) return
    const armed = this.armedIds().filter(
      (id) => projectStore.state.tracks[id]?.kind === 'audio'
    )
    if (armed.length === 0) {
      this.fail('Arm an audio track first (● on the track header)')
      return
    }
    try {
      const ctx = audioEngine.ensureContext()
      if (ctx.state === 'suspended') await ctx.resume()

      // Acquire inputs up front (permission prompts happen here), but hold
      // capture until the roll so a count-in never ends up in the take.
      for (const trackId of armed) {
        const config = trackInputs.configOf(trackId)
        let stream = streamOverride
        let deviceKey = ''
        if (!stream) {
          const acquired = await trackInputs.acquire(config.deviceId)
          stream = acquired.stream
          deviceKey = acquired.key
        }
        const tap = buildInputTap(ctx, stream, config.channels)
        this.captures.push({ trackId, recorder: new Recorder(), tap, deviceKey })
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
          void this.beginRoll(ctx)
        }, seconds * 1000)
        this.emit()
      } else {
        await this.beginRoll(ctx)
      }
    } catch (error) {
      this.teardownCaptures()
      this.fail(
        error instanceof DOMException && error.name === 'NotAllowedError'
          ? 'Microphone access was denied'
          : `Could not start recording: ${error instanceof Error ? error.message : String(error)}`
      )
    }
  }

  /** The count-in (if any) is over: capture and roll from here. */
  private async beginRoll(ctx: AudioContext): Promise<void> {
    try {
      for (const capture of this.captures) {
        await capture.recorder.start(ctx, capture.tap.output)
      }
      this.recordStartTicks = transport.positionTicks()
      this.rollAnchorSec = ctx.currentTime
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

  /** Release every capture rig (taps + pooled streams); keeps no takes. */
  private teardownCaptures(): void {
    for (const capture of this.captures) {
      capture.tap.dispose()
      if (capture.deviceKey) trackInputs.release(capture.deviceKey)
    }
    this.captures = []
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
    const takes = captures.map((capture) => ({ capture, take: capture.recorder.stop() }))
    for (const { capture } of takes) {
      capture.tap.dispose()
      if (capture.deviceKey) trackInputs.release(capture.deviceKey)
    }
    this.emit()

    const ctx = audioEngine.ensureContext()
    // Takes finish asynchronously: the WAV encode is chunked so hitting
    // Stop after a long multitrack take never freezes the app at the very
    // moment the user is most anxious about whether the take survived.
    void this.finishTakes(takes, ctx, this.recordStartTicks, this.rollAnchorSec)
  }

  private async finishTakes(
    takes: Array<{ capture: TrackCapture; take: ReturnType<Recorder['stop']> }>,
    ctx: AudioContext,
    anchorTicks: number,
    anchorSec: number
  ): Promise<void> {
    // Latency compensation. The performer played along with audio they
    // heard an output-latency LATE, so everything they did sits late in
    // the take by that amount; the manual trim absorbs the input path
    // (mic → buffers → worklet), which the platform does not report.
    const compensationSec =
      audioEngine.outputLatencySec() + preferences.recordLatencyTrimMs / 1000
    const tps = ticksPerSecond(projectStore.state.tempo)
    for (const { capture, take } of takes) {
      if (!take || take.seconds < 0.05) continue
      const track = projectStore.state.tracks[capture.trackId]
      if (!track || track.kind !== 'audio') continue
      // Place the take by where its FIRST SAMPLE actually sat on the audio
      // clock (announced by the capture worklet), not by when start() was
      // called — worklet spin-up would otherwise land every take late.
      const skewSec = take.startSec !== null ? take.startSec - anchorSec : 0
      const startTicks = Math.max(0, Math.round(anchorTicks + (skewSec - compensationSec) * tps))

      const buffer = ctx.createBuffer(
        Math.max(1, take.channels.length),
        take.channels[0].length,
        take.sampleRate
      )
      take.channels.forEach((data, ch) =>
        buffer.copyToChannel(data as Float32Array<ArrayBuffer>, ch)
      )
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
