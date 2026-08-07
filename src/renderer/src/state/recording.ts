import { useSyncExternalStore } from 'react'
import type { TrackId } from '@core/model/types'
import { newId } from '@core/model/ids'
import { Recorder } from '@audio/recorder'
import { buildInputTap, type InputTap } from '@audio/input'
import { encodeWavPcm16 } from '@audio/wav'
import { ticksPerSecond } from '@audio/scheduling'
import { projectStore } from './projectStore'
import { transport } from './transport'
import { audioEngine, assetStore } from './audioInstance'
import { trackInputs } from './trackInputs'

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
  recordStartTicks = 0
  lastError: string | null = null

  private captures: TrackCapture[] = []
  private takeCounter = 1

  private version = 0
  private listeners = new Set<() => void>()

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
    if (this.recording) return
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
        const recorder = new Recorder()
        await recorder.start(ctx, tap.output)
        this.captures.push({ trackId, recorder, tap, deviceKey })
      }

      this.recordStartTicks = transport.positionTicks()
      this.recording = true
      this.lastError = null
      if (!transport.isPlaying) transport.play()
      this.emit()
    } catch (error) {
      this.teardownCaptures()
      this.fail(
        error instanceof DOMException && error.name === 'NotAllowedError'
          ? 'Microphone access was denied'
          : `Could not start recording: ${error instanceof Error ? error.message : String(error)}`
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
    const startTicks = Math.max(0, Math.round(this.recordStartTicks))

    for (const { capture, take } of takes) {
      if (!take || take.seconds < 0.05) continue
      const track = projectStore.state.tracks[capture.trackId]
      if (!track || track.kind !== 'audio') continue

      const buffer = ctx.createBuffer(
        Math.max(1, take.channels.length),
        take.channels[0].length,
        take.sampleRate
      )
      take.channels.forEach((data, ch) =>
        buffer.copyToChannel(data as Float32Array<ArrayBuffer>, ch)
      )
      const wav = encodeWavPcm16(take.channels, take.sampleRate)

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
    if (this.recording) this.stop()
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
