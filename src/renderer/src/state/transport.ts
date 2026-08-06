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

/**
 * The cycle region: play everything inside it over and over. Like the
 * playhead it is per-user transport state, never document state — one
 * collaborator auditioning a chorus must not hijack everyone else's
 * playback.
 */
export interface LoopRegion {
  readonly start: number
  readonly end: number
}

export class Transport {
  private playing = false
  private baseTicks = 0
  private startedAt = 0 // TimeSource seconds at play start
  private tempo = projectStore.state.tempo
  private loop: LoopRegion | null = null
  private loopOn = false
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

  // ---------- Loop region ----------

  /** The region, whether or not cycling is switched on. */
  get loopRegion(): LoopRegion | null {
    return this.loop
  }

  get loopEnabled(): boolean {
    return this.loopOn
  }

  /** The region ONLY when it should actually cycle playback. */
  activeLoop(): LoopRegion | null {
    return this.loopOn && this.loop && this.loop.end > this.loop.start ? this.loop : null
  }

  setLoopRegion(start: number, end: number): void {
    const lo = Math.max(0, Math.min(start, end))
    const hi = Math.max(start, end)
    // Ignore degenerate drags (a click on the ruler is not a region).
    if (hi - lo < 1) return
    this.loop = { start: lo, end: hi }
    this.loopOn = true
    this.reanchorForLoopChange()
  }

  setLoopEnabled(enabled: boolean): void {
    if (this.loopOn === enabled) return
    this.loopOn = enabled
    this.reanchorForLoopChange()
  }

  clearLoop(): void {
    if (!this.loop) return
    this.loop = null
    this.loopOn = false
    this.reanchorForLoopChange()
  }

  /**
   * Changing the region mid-playback re-bases on the CURRENT (already
   * wrapped) position, then re-emits a seek so the engine reschedules
   * against the new region.
   */
  private reanchorForLoopChange(): void {
    if (this.playing) {
      this.baseTicks = this.positionTicks()
      this.startedAt = this.timeSource.now()
      this.emitEvent('seek')
    }
    this.emitFrame()
  }

  /**
   * Where the playhead is now. Cycling wraps here with pure modulo math off
   * the audio clock, so the reported position is exact — no polling, and
   * no drift between what is heard and what is drawn.
   */
  positionTicks(): number {
    if (!this.playing) return this.baseTicks
    const elapsedSec = this.timeSource.now() - this.startedAt
    const ticksPerSec = (this.tempo / 60) * PPQ
    const raw = this.baseTicks + elapsedSec * ticksPerSec
    const loop = this.activeLoop()
    if (!loop || raw < loop.end) return raw
    // Past the region's end: fold back into it. Starting before the region
    // therefore plays the run-up once, then cycles.
    const span = loop.end - loop.start
    return loop.start + ((raw - loop.end) % span)
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
