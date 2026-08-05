import type { ProjectState, TrackId } from '@core/model/types'
import type { AssetStore } from './assets'
import { beatIndexAt, metronomeClicks, scheduleClips } from './scheduling'

/**
 * The audio engine: owns the AudioContext and all routing.
 *
 *   clip sources ─▶ per-track GainNode ─▶ master GainNode ─▶ analyser ─▶ out
 *
 * Deliberately independent of React and of the (future) collaboration
 * layer: it consumes the project store, transport, and asset store through
 * the narrow structural interfaces below. Mute/solo are gain-level (not
 * schedule-level), so toggling them mid-playback is seamless.
 *
 * Scheduling strategy: on play/seek/edit, all upcoming clip sources are
 * (re)scheduled in one pass against the audio clock — exact and simple at
 * project scale. The metronome uses a small lookahead loop since it is
 * unbounded. AudioWorklet DSP comes later with mixing/metering needs;
 * native nodes are the right tool for clip playback.
 */

interface StoreLike {
  readonly state: ProjectState
  subscribe(listener: () => void): () => void
}

interface TransportLike {
  readonly isPlaying: boolean
  positionTicks(): number
  onEvent(listener: (event: 'play' | 'stop' | 'seek') => void): () => void
  setTimeSource(source: { now(): number }): void
}

const METRO_LOOKAHEAD_SEC = 0.15
const METRO_INTERVAL_MS = 40
const GAIN_SMOOTHING_SEC = 0.015

export class AudioEngine {
  private ctx: AudioContext | null = null
  private master: GainNode | null = null
  private analyser: AnalyserNode | null = null
  private meterBuf: Float32Array<ArrayBuffer> | null = null
  private trackGains = new Map<TrackId, GainNode>()
  private sources = new Set<AudioBufferSourceNode>()

  private anchorTicks = 0
  private anchorSec = 0

  private metroEnabled = false
  private metroListeners = new Set<() => void>()
  private metroTimer: ReturnType<typeof setInterval> | null = null
  private nextBeatIndex = 0

  private prevTracks: ProjectState['tracks']
  private prevClips: ProjectState['clips']
  private prevTempo: number

  constructor(
    private store: StoreLike,
    private transport: TransportLike,
    private assets: AssetStore
  ) {
    this.prevTracks = store.state.tracks
    this.prevClips = store.state.clips
    this.prevTempo = store.state.tempo
    store.subscribe(this.onStateChanged)
    assets.subscribe(this.onAssetsChanged)
    transport.onEvent(this.onTransportEvent)
  }

  /** Create the AudioContext (idempotent). Safe pre-gesture; starts suspended. */
  ensureContext(): AudioContext {
    if (this.ctx) return this.ctx
    const ctx = new AudioContext({ latencyHint: 'interactive' })
    this.ctx = ctx
    this.master = ctx.createGain()
    this.analyser = ctx.createAnalyser()
    this.analyser.fftSize = 2048
    this.meterBuf = new Float32Array(this.analyser.fftSize)
    this.master.connect(this.analyser)
    this.analyser.connect(ctx.destination)
    // From here on the playhead runs on the audio clock — no drift between
    // what the user sees and what they hear.
    this.transport.setTimeSource({ now: () => ctx.currentTime })
    this.syncTrackGains()
    return ctx
  }

  async decode(data: ArrayBuffer): Promise<AudioBuffer> {
    return this.ensureContext().decodeAudioData(data)
  }

  // ---------- Metronome ----------

  get metronomeEnabled(): boolean {
    return this.metroEnabled
  }

  setMetronome(enabled: boolean): void {
    if (this.metroEnabled === enabled) return
    this.metroEnabled = enabled
    if (enabled && this.transport.isPlaying) this.startMetronome()
    for (const listener of this.metroListeners) listener()
  }

  subscribeMetronome = (listener: () => void): (() => void) => {
    this.metroListeners.add(listener)
    return () => this.metroListeners.delete(listener)
  }

  // ---------- Metering ----------

  /** Instantaneous master peak level, 0..1. Zero when the engine is idle. */
  meterLevel(): number {
    if (!this.analyser || !this.meterBuf) return 0
    this.analyser.getFloatTimeDomainData(this.meterBuf)
    let peak = 0
    for (let i = 0; i < this.meterBuf.length; i++) {
      const v = Math.abs(this.meterBuf[i])
      if (v > peak) peak = v
    }
    return Math.min(1, peak)
  }

  // ---------- Transport / state reactions ----------

  private onTransportEvent = (event: 'play' | 'stop' | 'seek'): void => {
    if (event === 'stop') {
      this.stopAllSources()
      this.stopMetronome()
      return
    }
    if (event === 'seek' && !this.transport.isPlaying) return

    const ctx = this.ensureContext()
    const go = (): void => {
      this.stopAllSources()
      this.reanchor()
      this.scheduleAllClips()
      this.startMetronome()
    }
    if (ctx.state === 'suspended') void ctx.resume().then(go)
    else go()
  }

  private onStateChanged = (): void => {
    const state = this.store.state
    if (state.tracks !== this.prevTracks) {
      this.prevTracks = state.tracks
      if (this.ctx) this.syncTrackGains()
    }
    const editedAudio = state.clips !== this.prevClips || state.tempo !== this.prevTempo
    this.prevClips = state.clips
    this.prevTempo = state.tempo
    // Reschedule only when something audible changed; unrelated ops
    // (renames etc.) must never interrupt playback.
    if (editedAudio && this.transport.isPlaying && this.ctx) {
      this.stopAllSources()
      this.reanchor()
      this.scheduleAllClips()
      this.resyncMetronome()
    }
  }

  private onAssetsChanged = (): void => {
    // A newly decoded asset may belong to an already-scheduled silent clip.
    if (this.transport.isPlaying && this.ctx) {
      this.stopAllSources()
      this.reanchor()
      this.scheduleAllClips()
    }
  }

  // ---------- Internals ----------

  private reanchor(): void {
    if (!this.ctx) return
    this.anchorSec = this.ctx.currentTime
    this.anchorTicks = this.transport.positionTicks()
  }

  private scheduleAllClips(): void {
    const ctx = this.ctx
    if (!ctx) return
    const schedules = scheduleClips(
      this.store.state,
      (id) => this.assets.getSeconds(id),
      this.anchorTicks,
      this.anchorSec
    )
    for (const s of schedules) {
      const asset = this.assets.get(s.assetId)
      if (!asset?.buffer) continue
      const source = ctx.createBufferSource()
      source.buffer = asset.buffer
      source.connect(this.trackGain(s.trackId))
      source.onended = () => this.sources.delete(source)
      source.start(s.when, s.offsetSec, s.durationSec)
      this.sources.add(source)
    }
  }

  private stopAllSources(): void {
    for (const source of this.sources) {
      source.onended = null
      try {
        source.stop()
      } catch {
        // never started or already stopped — fine
      }
      source.disconnect()
    }
    this.sources.clear()
  }

  private trackGain(trackId: TrackId): GainNode {
    const existing = this.trackGains.get(trackId)
    if (existing) return existing
    const ctx = this.ensureContext()
    const gain = ctx.createGain()
    gain.gain.value = this.effectiveGain(trackId)
    gain.connect(this.master!)
    this.trackGains.set(trackId, gain)
    return gain
  }

  private effectiveGain(trackId: TrackId): number {
    const state = this.store.state
    const track = state.tracks[trackId]
    if (!track) return 0
    const anySolo = Object.values(state.tracks).some((t) => t.soloed)
    return track.muted || (anySolo && !track.soloed) ? 0 : 1
  }

  private syncTrackGains(): void {
    const ctx = this.ctx
    if (!ctx) return
    for (const [trackId, gain] of this.trackGains) {
      if (!this.store.state.tracks[trackId]) {
        gain.disconnect()
        this.trackGains.delete(trackId)
        continue
      }
      gain.gain.setTargetAtTime(this.effectiveGain(trackId), ctx.currentTime, GAIN_SMOOTHING_SEC)
    }
    for (const trackId of Object.keys(this.store.state.tracks)) {
      if (!this.trackGains.has(trackId)) this.trackGain(trackId)
    }
  }

  private startMetronome(): void {
    this.resyncMetronome()
    if (this.metroTimer !== null) return
    this.metroTimer = setInterval(this.metroTick, METRO_INTERVAL_MS)
    this.metroTick()
  }

  private stopMetronome(): void {
    if (this.metroTimer !== null) clearInterval(this.metroTimer)
    this.metroTimer = null
  }

  private resyncMetronome(): void {
    this.nextBeatIndex = beatIndexAt(this.store.state, this.transport.positionTicks())
  }

  private metroTick = (): void => {
    const ctx = this.ctx
    if (!ctx || !this.metroEnabled || !this.transport.isPlaying) return
    const now = ctx.currentTime
    const { clicks, nextBeatIndex } = metronomeClicks(
      this.store.state,
      this.anchorTicks,
      this.anchorSec,
      this.nextBeatIndex,
      now - 0.01,
      now + METRO_LOOKAHEAD_SEC
    )
    this.nextBeatIndex = nextBeatIndex
    for (const click of clicks) this.scheduleClick(click.when, click.isDownbeat)
  }

  private scheduleClick(when: number, isDownbeat: boolean): void {
    const ctx = this.ctx!
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.frequency.value = isDownbeat ? 1320 : 880
    gain.gain.setValueAtTime(0.5, when)
    gain.gain.exponentialRampToValueAtTime(0.001, when + 0.05)
    osc.connect(gain)
    gain.connect(this.master!)
    osc.start(when)
    osc.stop(when + 0.06)
  }
}
