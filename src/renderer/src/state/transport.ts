import { PPQ } from '@core/model/timebase'
import { isTrackEffectivelyAudible } from '@core/model/types'
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

/**
 * Timeline end of the AUDIBLE project, in ticks (0 = nothing to hear).
 * Muted tracks — and, while any solo is active, everything the solo
 * silences — are left out, so looping the song wraps at the end of what
 * is actually being heard rather than at the end of material nobody is
 * listening to. Soloing a chorus therefore cycles the chorus.
 *
 * Cached on the clips AND tracks records' identities: positionTicks()
 * calls this on every animation frame from several subscribers, and
 * scanning a thousand clips per frame purely to recompute a constant
 * would waste hundreds of thousands of iterations per second.
 */
let songEndForClips: unknown = null
let songEndForTracks: unknown = null
let songEndValue = 0
function songEndTicks(): number {
  const state = projectStore.state
  const { clips, tracks } = state
  if (songEndForClips !== clips || songEndForTracks !== tracks) {
    // Audibility is a per-track answer walking the folder chain; resolve
    // it once per track rather than once per clip.
    const audible = new Map<string, boolean>()
    let end = 0
    for (const clip of Object.values(clips)) {
      let ok = audible.get(clip.trackId)
      if (ok === undefined) {
        ok = isTrackEffectivelyAudible(state, clip.trackId)
        audible.set(clip.trackId, ok)
      }
      if (ok) end = Math.max(end, clip.start + clip.duration)
    }
    songEndForClips = clips
    songEndForTracks = tracks
    songEndValue = end
  }
  return songEndValue
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
  /**
   * Seconds the HEARD output lags the audio clock (base + output latency;
   * the engine keeps it fresh). Display-only: scheduling stays on the raw
   * clock, but the playhead is drawn — and playhead-anchored edits land —
   * where the listener actually is in the song, not 10–100 ms ahead.
   */
  private outputLatencySec = 0
  private timeSource: TimeSource = { now: () => performance.now() / 1000 }
  private frameListeners = new Set<() => void>()
  private uiListeners = new Set<() => void>()
  private eventListeners = new Set<(event: TransportEvent) => void>()
  private rafId: number | null = null

  /** Wrap point the running song loop was last scheduled against. */
  private songLoopEnd = 0

  constructor() {
    projectStore.subscribe(() => {
      // Re-anchor on tempo changes so elapsed time already played is not
      // retroactively rescaled (which would make the playhead jump).
      const tempo = projectStore.state.tempo
      if (tempo !== this.tempo) {
        this.baseTicks = this.positionTicks()
        this.startedAt = this.timeSource.now()
        this.tempo = tempo
      }
      // The song loop's wrap point is the end of the AUDIBLE material, so
      // muting or soloing moves it. The engine pre-schedules a whole
      // iteration ahead, so the new region has to be re-queued — otherwise
      // sources beyond the new end keep sounding after the playhead wraps.
      if (this.playing && this.songLoopOn && !this.explicitRegionActive()) {
        const end = songEndTicks()
        if (end !== this.songLoopEnd) {
          this.songLoopEnd = end
          this.reanchorForLoopChange(this.positionTicks())
        }
      }
    })
  }

  /** An explicit cycle region overrides the song loop while it is on. */
  private explicitRegionActive(): boolean {
    return this.loopOn && this.loop !== null && this.loop.end > this.loop.start
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
    if (this.explicitRegionActive()) return this.loop
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
    this.songLoopEnd = songEndTicks()
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
    this.emitDiscrete()
  }

  /**
   * Where the playhead is now, on the RAW audio clock — the engine's
   * scheduling domain. Cycling wraps here with pure modulo math, so the
   * reported position is exact — no polling, no drift.
   */
  positionTicks(): number {
    if (!this.playing) return this.baseTicks
    return this.positionAt(this.timeSource.now())
  }

  /**
   * Where the playhead should be DRAWN: the position whose audio is
   * reaching the ears right now, i.e. the raw position an output-latency
   * ago. Clamped to the play start so pressing play never shows a
   * backwards hop while the first buffers are still in flight.
   */
  displayTicks(): number {
    if (!this.playing || this.outputLatencySec === 0) return this.positionTicks()
    return this.positionAt(Math.max(this.startedAt, this.timeSource.now() - this.outputLatencySec))
  }

  /** The engine reports the live output-path latency here. */
  setOutputLatency(seconds: number): void {
    this.outputLatencySec = Number.isFinite(seconds) ? Math.max(0, seconds) : 0
  }

  private positionAt(nowSec: number): number {
    const elapsedSec = nowSec - this.startedAt
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
    this.emitDiscrete()
  }

  clearMarker(): void {
    if (this.marker === null) return
    this.marker = null
    this.emitDiscrete()
  }

  /**
   * Where an edit lands: the marker when one is pinned, otherwise the
   * playhead — the DRAWN one, so slicing at the playhead cuts where the
   * user sees (and hears) it, not where the clock has silently run ahead.
   */
  editTicks(): number {
    return this.marker ?? this.displayTicks()
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
    this.emitDiscrete()
  }

  stop(): void {
    if (!this.playing) {
      // Second stop returns to project start, like most DAWs.
      this.baseTicks = 0
      this.emitEvent('seek')
      this.emitDiscrete()
      return
    }
    this.baseTicks = this.positionTicks()
    this.playing = false
    if (this.rafId !== null) cancelAnimationFrame(this.rafId)
    this.rafId = null
    this.emitEvent('stop')
    this.emitDiscrete()
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
    this.emitDiscrete()
  }

  /**
   * Fires every animation frame while playing, and on play/stop/seek. ONLY
   * for things that track the moving playhead (leaf components writing a
   * transform). Anything that renders layout must use subscribeUi instead —
   * a frame subscription re-renders it at 60 fps for the whole of playback.
   */
  subscribe = (listener: () => void): (() => void) => {
    this.frameListeners.add(listener)
    return () => this.frameListeners.delete(listener)
  }

  /**
   * Fires only on discrete transport-state changes: play/stop/seek, loop
   * region and cycling toggles, marker moves. Never per frame. This is what
   * views subscribe to when they draw transport STATE (loop strip, marker,
   * button states) rather than the moving playhead.
   */
  subscribeUi = (listener: () => void): (() => void) => {
    this.uiListeners.add(listener)
    return () => this.uiListeners.delete(listener)
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

  /** A discrete transport-state change: both audiences hear about it. */
  private emitDiscrete(): void {
    for (const listener of this.uiListeners) listener()
    this.emitFrame()
  }

  private emitEvent(event: TransportEvent): void {
    for (const listener of this.eventListeners) listener(event)
  }
}

export const transport = new Transport()
