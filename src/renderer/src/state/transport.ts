import { PPQ } from '@core/model/timebase'
import { projectStore } from './projectStore'

/**
 * Playback transport. Purely local/ephemeral — the playhead is per-user
 * state and is never part of the synchronized project document. (Later,
 * collaborators' playheads are shared via the presence channel instead.)
 *
 * Time comes from a pluggable TimeSource. Before the audio engine starts it
 * is the wall clock; once an AudioContext exists the engine installs the
 * audio clock, so the playhead and scheduled audio can never drift apart.
 */

export interface TimeSource {
  /** Monotonic time in seconds. */
  now(): number
}

export type TransportEvent = 'play' | 'stop' | 'seek'

export class Transport {
  private playing = false
  private baseTicks = 0
  private startedAt = 0 // TimeSource seconds at play start
  private tempo = projectStore.state.tempo
  private timeSource: TimeSource = { now: () => performance.now() / 1000 }
  private frameListeners = new Set<() => void>()
  private eventListeners = new Set<(event: TransportEvent) => void>()
  private rafId: number | null = null

  constructor() {
    // Re-anchor on tempo changes so elapsed time already played is not
    // retroactively rescaled (which would make the playhead jump).
    projectStore.subscribe(() => {
      const tempo = projectStore.state.tempo
      if (tempo === this.tempo) return
      this.baseTicks = this.positionTicks()
      this.startedAt = this.timeSource.now()
      this.tempo = tempo
    })
  }

  get isPlaying(): boolean {
    return this.playing
  }

  positionTicks(): number {
    if (!this.playing) return this.baseTicks
    const elapsedSec = this.timeSource.now() - this.startedAt
    const ticksPerSec = (this.tempo / 60) * PPQ
    return this.baseTicks + elapsedSec * ticksPerSec
  }

  /** Swap the clock (e.g. to AudioContext time) without moving the playhead. */
  setTimeSource(source: TimeSource): void {
    this.baseTicks = this.positionTicks()
    this.timeSource = source
    this.startedAt = source.now()
  }

  play(): void {
    if (this.playing) return
    this.playing = true
    this.startedAt = this.timeSource.now()
    this.tick()
    this.emitEvent('play')
    this.emitFrame()
  }

  stop(): void {
    if (!this.playing) {
      // Second stop returns to project start, like most DAWs.
      this.baseTicks = 0
      this.emitEvent('seek')
      this.emitFrame()
      return
    }
    this.baseTicks = this.positionTicks()
    this.playing = false
    if (this.rafId !== null) cancelAnimationFrame(this.rafId)
    this.rafId = null
    this.emitEvent('stop')
    this.emitFrame()
  }

  toggle(): void {
    this.playing ? this.stop() : this.play()
  }

  setPosition(ticks: number): void {
    this.baseTicks = Math.max(0, ticks)
    if (this.playing) this.startedAt = this.timeSource.now()
    this.emitEvent('seek')
    this.emitFrame()
  }

  /** Fires every animation frame while playing, and on play/stop/seek. For display. */
  subscribe = (listener: () => void): (() => void) => {
    this.frameListeners.add(listener)
    return () => this.frameListeners.delete(listener)
  }

  /** Discrete transport events. For the audio engine. */
  onEvent(listener: (event: TransportEvent) => void): () => void {
    this.eventListeners.add(listener)
    return () => this.eventListeners.delete(listener)
  }

  private tick = (): void => {
    if (!this.playing) return
    this.emitFrame()
    this.rafId = requestAnimationFrame(this.tick)
  }

  private emitFrame(): void {
    for (const listener of this.frameListeners) listener()
  }

  private emitEvent(event: TransportEvent): void {
    for (const listener of this.eventListeners) listener(event)
  }
}

export const transport = new Transport()
