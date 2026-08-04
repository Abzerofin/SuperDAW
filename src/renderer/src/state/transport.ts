import { PPQ } from '@core/model/timebase'
import { projectStore } from './projectStore'

/**
 * Playback transport. Purely local/ephemeral — the playhead is per-user
 * state and is never part of the synchronized project document. (Later,
 * collaborators' playheads are shared via the presence channel instead.)
 *
 * No audio yet: the transport drives the playhead so the timeline behaves
 * like a DAW; the audio engine milestone will attach to this same interface.
 */
class Transport {
  private playing = false
  private baseTicks = 0
  private startedAt = 0 // performance.now() when playback started
  private listeners = new Set<() => void>()
  private rafId: number | null = null

  get isPlaying(): boolean {
    return this.playing
  }

  positionTicks(): number {
    if (!this.playing) return this.baseTicks
    const elapsedSec = (performance.now() - this.startedAt) / 1000
    const ticksPerSec = (projectStore.state.tempo / 60) * PPQ
    return this.baseTicks + elapsedSec * ticksPerSec
  }

  play(): void {
    if (this.playing) return
    this.playing = true
    this.startedAt = performance.now()
    this.tick()
    this.emit()
  }

  stop(): void {
    if (!this.playing) {
      // Second stop returns to project start, like most DAWs.
      this.baseTicks = 0
      this.emit()
      return
    }
    this.baseTicks = this.positionTicks()
    this.playing = false
    if (this.rafId !== null) cancelAnimationFrame(this.rafId)
    this.rafId = null
    this.emit()
  }

  toggle(): void {
    this.playing ? this.stop() : this.play()
  }

  setPosition(ticks: number): void {
    this.baseTicks = Math.max(0, ticks)
    if (this.playing) this.startedAt = performance.now()
    this.emit()
  }

  /** Listeners fire every animation frame while playing, and on play/stop/seek. */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private tick = (): void => {
    if (!this.playing) return
    this.emit()
    this.rafId = requestAnimationFrame(this.tick)
  }

  private emit(): void {
    for (const listener of this.listeners) listener()
  }
}

export const transport = new Transport()
