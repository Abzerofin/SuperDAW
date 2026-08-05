import type { ProjectState, TrackId } from '@core/model/types'
import { automationOf, automationValueAt } from '@core/model/types'
import type { AssetStore } from './assets'
import { beatIndexAt, metronomeClicks, scheduleClips, ticksPerSecond } from './scheduling'

/**
 * The audio engine: owns the AudioContext and all routing.
 *
 *   clip sources ─▶ autoGain ─▶ fader ─▶ panner ─▶ master ─▶ analyser ─▶ out
 *                  (automation)  (volume ×        (masterVolume)
 *                                 mute/solo)
 *
 * Deliberately independent of React and of the collaboration layer: it
 * consumes the project store, transport, and asset store through the
 * narrow structural interfaces below. Mixer changes are gain-level (not
 * schedule-level), so they are seamless mid-playback; volume automation
 * is compiled to Web Audio linear ramps on the autoGain node, so curves
 * are sample-accurate regardless of UI frame rate.
 *
 * Scheduling strategy: on play/seek/edit, all upcoming clip sources are
 * (re)scheduled in one pass against the audio clock — exact and simple at
 * project scale. The metronome uses a small lookahead loop since it is
 * unbounded. AudioWorklet DSP comes later with per-strip metering needs;
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

interface TrackChain {
  auto: GainNode
  fader: GainNode
  panner: StereoPannerNode
}

export class AudioEngine {
  private ctx: AudioContext | null = null
  private master: GainNode | null = null
  private analyser: AnalyserNode | null = null
  private meterBuf: Float32Array<ArrayBuffer> | null = null
  private chains = new Map<TrackId, TrackChain>()
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
  private prevAutomation: ProjectState['automation']
  private prevMasterVolume: number

  constructor(
    private store: StoreLike,
    private transport: TransportLike,
    private assets: AssetStore
  ) {
    this.prevTracks = store.state.tracks
    this.prevClips = store.state.clips
    this.prevTempo = store.state.tempo
    this.prevAutomation = store.state.automation
    this.prevMasterVolume = store.state.masterVolume
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
    this.master.gain.value = this.store.state.masterVolume
    this.analyser = ctx.createAnalyser()
    this.analyser.fftSize = 2048
    this.meterBuf = new Float32Array(this.analyser.fftSize)
    this.master.connect(this.analyser)
    this.analyser.connect(ctx.destination)
    // From here on the playhead runs on the audio clock — no drift between
    // what the user sees and what they hear.
    this.transport.setTimeSource({ now: () => ctx.currentTime })
    this.syncMixer()
    return ctx
  }

  // ---------- Ephemeral previews (fader/knob drags before the op lands) ----------

  previewTrackVolume(trackId: TrackId, volume: number): void {
    const chain = this.ctx ? this.chain(trackId) : null
    if (chain && this.ctx) {
      chain.fader.gain.setTargetAtTime(
        this.isAudible(trackId) ? volume : 0,
        this.ctx.currentTime,
        GAIN_SMOOTHING_SEC
      )
    }
  }

  previewTrackPan(trackId: TrackId, pan: number): void {
    const chain = this.ctx ? this.chain(trackId) : null
    if (chain && this.ctx) chain.panner.pan.setTargetAtTime(pan, this.ctx.currentTime, GAIN_SMOOTHING_SEC)
  }

  previewMasterVolume(volume: number): void {
    if (this.ctx && this.master) {
      this.master.gain.setTargetAtTime(volume, this.ctx.currentTime, GAIN_SMOOTHING_SEC)
    }
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
      this.scheduleAutomation()
      this.startMetronome()
    }
    if (ctx.state === 'suspended') void ctx.resume().then(go)
    else go()
  }

  private onStateChanged = (): void => {
    const state = this.store.state
    if (state.tracks !== this.prevTracks || state.masterVolume !== this.prevMasterVolume) {
      this.prevTracks = state.tracks
      this.prevMasterVolume = state.masterVolume
      if (this.ctx) this.syncMixer()
    }
    const automationEdited = state.automation !== this.prevAutomation
    this.prevAutomation = state.automation
    if (automationEdited && this.transport.isPlaying && this.ctx) {
      this.scheduleAutomation()
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
      source.connect(this.chain(s.trackId).auto)
      source.onended = () => this.sources.delete(source)
      source.start(s.when, s.offsetSec, s.durationSec)
      this.sources.add(source)
    }
  }

  /** Compile volume automation to linear ramps from the current position. */
  private scheduleAutomation(): void {
    const ctx = this.ctx
    if (!ctx) return
    const state = this.store.state
    const tps = ticksPerSecond(state.tempo)
    const now = ctx.currentTime
    const nowTicks = this.anchorTicks + (now - this.anchorSec) * tps

    for (const trackId of Object.keys(state.tracks)) {
      const auto = this.chain(trackId).auto
      auto.gain.cancelScheduledValues(now)
      const points = automationOf(state, trackId, 'volume')
      auto.gain.setValueAtTime(automationValueAt(points, nowTicks), now)
      for (const point of points) {
        if (point.ticks <= nowTicks) continue
        auto.gain.linearRampToValueAtTime(
          point.value,
          this.anchorSec + (point.ticks - this.anchorTicks) / tps
        )
      }
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

  private chain(trackId: TrackId): TrackChain {
    const existing = this.chains.get(trackId)
    if (existing) return existing
    const ctx = this.ensureContext()
    const auto = ctx.createGain()
    const fader = ctx.createGain()
    const panner = ctx.createStereoPanner()
    fader.gain.value = this.effectiveGain(trackId)
    panner.pan.value = this.store.state.tracks[trackId]?.pan ?? 0
    auto.connect(fader)
    fader.connect(panner)
    panner.connect(this.master!)
    const chain: TrackChain = { auto, fader, panner }
    this.chains.set(trackId, chain)
    return chain
  }

  private isAudible(trackId: TrackId): boolean {
    const state = this.store.state
    const track = state.tracks[trackId]
    if (!track) return false
    const anySolo = Object.values(state.tracks).some((t) => t.soloed)
    return !(track.muted || (anySolo && !track.soloed))
  }

  /** Fader gain: track volume, or 0 when muted / not soloed while solo is on. */
  private effectiveGain(trackId: TrackId): number {
    const track = this.store.state.tracks[trackId]
    if (!track) return 0
    return this.isAudible(trackId) ? track.volume : 0
  }

  private syncMixer(): void {
    const ctx = this.ctx
    if (!ctx) return
    const now = ctx.currentTime
    this.master!.gain.setTargetAtTime(this.store.state.masterVolume, now, GAIN_SMOOTHING_SEC)
    for (const [trackId, chain] of this.chains) {
      const track = this.store.state.tracks[trackId]
      if (!track) {
        chain.auto.disconnect()
        chain.fader.disconnect()
        chain.panner.disconnect()
        this.chains.delete(trackId)
        continue
      }
      chain.fader.gain.setTargetAtTime(this.effectiveGain(trackId), now, GAIN_SMOOTHING_SEC)
      chain.panner.pan.setTargetAtTime(track.pan, now, GAIN_SMOOTHING_SEC)
    }
    for (const trackId of Object.keys(this.store.state.tracks)) {
      if (!this.chains.has(trackId)) this.chain(trackId)
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
