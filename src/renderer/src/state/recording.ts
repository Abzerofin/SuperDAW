import { useSyncExternalStore } from 'react'
import type { TrackId } from '@core/model/types'
import { newId } from '@core/model/ids'
import { Recorder } from '@audio/recorder'
import { encodeWavPcm16 } from '@audio/wav'
import { ticksPerSecond } from '@audio/scheduling'
import { projectStore } from './projectStore'
import { transport } from './transport'
import { audioEngine, assetStore } from './audioInstance'

/**
 * Recording session state (all ephemeral, per-user): which tracks are
 * armed, whether capture is running, and the region being recorded.
 * On stop, the take becomes a normal asset + bay entry + clip(s) through
 * ordinary ops — so a recording reaches collaborators through the exact
 * same machinery as an imported file.
 */
class RecordingStore {
  private armedTracks = new Set<TrackId>()
  recording = false
  recordStartTicks = 0
  lastError: string | null = null

  private recorder = new Recorder()
  private stream: MediaStream | null = null
  private ownsStream = false
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
      let stream = streamOverride
      if (!stream) {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false }
        })
        this.ownsStream = true
      } else {
        this.ownsStream = false
      }
      this.stream = stream
      await this.recorder.start(ctx, stream)
      this.recordStartTicks = transport.positionTicks()
      this.recording = true
      this.lastError = null
      if (!transport.isPlaying) transport.play()
      this.emit()
    } catch (error) {
      this.fail(
        error instanceof DOMException && error.name === 'NotAllowedError'
          ? 'Microphone access was denied'
          : `Could not start recording: ${error instanceof Error ? error.message : String(error)}`
      )
    }
  }

  /** Stop capture and turn the take into asset + bay entry + clip(s). */
  stop(): void {
    if (!this.recording) return
    this.recording = false
    const take = this.recorder.stop()
    if (this.ownsStream) this.stream?.getTracks().forEach((t) => t.stop())
    this.stream = null
    this.emit()
    if (!take || take.seconds < 0.05) return

    const ctx = audioEngine.ensureContext()
    const buffer = ctx.createBuffer(
      Math.max(1, take.channels.length),
      take.channels[0].length,
      take.sampleRate
    )
    take.channels.forEach((data, ch) => buffer.copyToChannel(data as Float32Array<ArrayBuffer>, ch))
    const wav = encodeWavPcm16(take.channels, take.sampleRate)

    const name = `Recording ${this.takeCounter++}.wav`
    const asset = assetStore.restore(newId('ast'), name, 'audio', 'wav', wav, buffer)

    projectStore.dispatch({
      type: 'file/create',
      nodes: [
        {
          id: newId('fil'),
          parentId: null,
          kind: 'audio',
          name: name.replace(/\.wav$/, ''),
          assetId: asset.id
        }
      ]
    })
    const durationTicks = Math.max(
      1,
      Math.round(take.seconds * ticksPerSecond(projectStore.state.tempo))
    )
    for (const trackId of this.armedIds()) {
      if (projectStore.state.tracks[trackId]?.kind !== 'audio') continue
      projectStore.dispatch({
        type: 'clip/create',
        clip: {
          id: newId('clp'),
          trackId,
          name: name.replace(/\.wav$/, ''),
          start: Math.max(0, Math.round(this.recordStartTicks)),
          duration: durationTicks,
          assetId: asset.id,
          offset: 0,
          color: null
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
