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

/** Timeline end of the current project, in ticks (0 = empty project). */
function songEndTicks(): number {
  let end = 0
  for (const clip of Object.values(projectStore.state.clips)) {
    end = Math.max(end, clip.start + clip.duration)
  }
  return end
}

export class Transport {
  private playing = false
  private baseTicks = 0
  private startedAt = 0 // TimeSource seconds at play start
  /** Where the playhead stood when play was pressed — stop returns here. */
  private playStartTicks = 0
  private tempo = projectStore.state.tempo
  private loop: LoopRegion | null = null
  private loopOn = false
  private songLoopOn = false
  /**
   * A pinned edit position. The playhead moves during playback, which makes
   * "at the playhead" edits (slice, paste) unusable while the song runs —
   * the marker is a spot that stays put so you can keep working over the
   * top of playback. Per-user and ephemeral, like the playhead itself.
   */
  private marker: number | null = null
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
    if (this.loopOn && this.loop && this.loop.end > this.loop.start) return this.loop
    // Song loop: cycle the whole project. Computed fresh each call so
    // edits that lengthen the song extend the cycle without ceremony. An
    // explicit region wins — it is the more deliberate gesture.
    if (this.songLoopOn) {
      const end = songEndTicks()
      if (end > 0) return { start: 0, end }
    }
    return null
  }

  get songLoopEnabled(): boolean {
    return this.songLoopOn
  }

  /** Loop the entire song: reaching the end wraps back to the start. */
  setSongLoop(enabled: boolean): void {
    if (this.songLoopOn === enabled) return
    const resumeAt = this.positionTicks()
    this.songLoopOn = enabled
    this.reanchorForLoopChange(resumeAt)
  }

  setLoopRegion(start: number, end: number): void {
    const lo = Math.max(0, Math.min(start, end))
    const hi = Math.max(start, end)
    // Ignore degenerate drags (a click on the ruler is not a region).
    if (hi - lo < 1) return
    const resumeAt = this.positionTicks()
    this.loop = { start: lo, end: hi }
    this.loopOn = true
    this.reanchorForLoopChange(resumeAt)
  }

  setLoopEnabled(enabled: boolean): void {
    if (this.loopOn === enabled) return
    const resumeAt = this.positionTicks()
    this.loopOn = enabled
    this.reanchorForLoopChange(resumeAt)
  }

  clearLoop(): void {
    if (!this.loop) return
    const resumeAt = this.positionTicks()
    this.loop = null
    this.loopOn = false
    this.reanchorForLoopChange(resumeAt)
  }

  /**
   * Changing the loop mid-playback re-bases on where the playhead audibly
   * IS, then re-emits a seek so the engine reschedules against the new
   * region.
   *
   * `resumeAt` MUST be sampled by the caller BEFORE it mutates any loop
   * state. The wrap lives only in positionTicks()'s return value —
   * baseTicks itself grows linearly for the whole cycling session — so
   * reading the position after switching cycling off would surface that
   * runaway value (loop 3× over 4 bars and land at bar 13) and freeze it
   * into baseTicks permanently.
   */
  private reanchorForLoopChange(resumeAt: number): void {
    if (this.playing) {
      this.baseTicks = resumeAt
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

  // ---------- Edit marker ----------

  /** The pinned edit position, or null when edits follow the playhead. */
  get markerTicks(): number | null {
    return this.marker
  }

  setMarker(ticks: number): void {
    const at = Math.max(0, Math.round(ticks))
    if (this.marker === at) return
    this.marker = at
    this.emitFrame()
  }

  clearMarker(): void {
    if (this.marker === null) return
    this.marker = null
    this.emitFrame()
  }

  /**
   * Where an edit lands: the marker when one is pinned, otherwise the
   * playhead. Everything that used to read `positionTicks()` for an EDIT
   * (as opposed to for drawing) goes through this.
   */
  editTicks(): number {
    return this.marker ?? this.positionTicks()
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
    this.playStartTicks = this.baseTicks
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

  /**
   * The DAW stop gesture: stop AND return the playhead to where it stood
   * when play was pressed. A second stop goes to the song start.
   */
  stopReturn(): void {
    if (this.playing) {
      this.stop()
      this.setPosition(this.playStartTicks)
    } else {
      this.setPosition(0)
    }
  }

  /** Space: play from here, or stop-and-return. */
  toggleReturn(): void {
    this.playing ? this.stopReturn() : this.play()
  }

  /** Shift+Space: stop (if playing) and go to the very beginning. */
  returnToStart(): void {
    if (this.playing) this.stop()
    this.setPosition(0)
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
