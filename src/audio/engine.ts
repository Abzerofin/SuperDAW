import type { PluginInstanceId, ProjectState, TrackId } from '@core/model/types'
import {
  automationOf,
  automationValueAt,
  isTrackAudible,
  pluginsOfTrack
} from '@core/model/types'
import type { AssetStore } from './assets'
import { applyClipFades } from './fades'
import { pluginRegistry, type PluginNodes } from './pluginRegistry'
import { buildSynthVoice } from './synth'
import {
  beatIndexAt,
  metronomeClicks,
  scheduleClips,
  scheduleNotes,
  ticksPerSecond
} from './scheduling'

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
  /** The cycle region when looping is on, else null. */
  activeLoop(): { start: number; end: number } | null
}

const METRO_LOOKAHEAD_SEC = 0.15
const METRO_INTERVAL_MS = 40
const GAIN_SMOOTHING_SEC = 0.015
/** How far ahead loop iterations are queued, and how often that is topped up. */
const LOOP_LOOKAHEAD_SEC = 4
const LOOP_INTERVAL_MS = 250

interface TrackChain {
  /** Where sources and synth voices connect; head of the insert chain. */
  input: GainNode
  auto: GainNode
  fader: GainNode
  panner: StereoPannerNode
  /** Side-tap off the panner for the track's level meter (never in the path). */
  analyser: AnalyserNode
  meterBuf: Float32Array<ArrayBuffer>
  /** Folder bus this chain's panner feeds (null = master). Folders ARE buses. */
  parentId: TrackId | null
}

export class AudioEngine {
  private ctx: AudioContext | null = null
  private master: GainNode | null = null
  private analyser: AnalyserNode | null = null
  private meterBuf: Float32Array<ArrayBuffer> | null = null
  private chains = new Map<TrackId, TrackChain>()
  private fxNodes = new Map<PluginInstanceId, PluginNodes>()
  /** Everything currently scheduled: clip buffer sources AND synth oscillators. */
  private sources = new Set<AudioScheduledSourceNode>()
  /** Per-clip fade envelope gains for the current scheduling pass. */
  private fadeNodes = new Set<GainNode>()
  /** Live input monitors feeding track chains, by track. */
  private monitors = new Map<TrackId, AudioNode>()

  private anchorTicks = 0
  private anchorSec = 0

  /** Desired output device; null = system default. Applied when the ctx exists. */
  private outputDeviceId: string | null = null

  private metroEnabled = false
  private metroListeners = new Set<() => void>()
  private metroTimer: ReturnType<typeof setInterval> | null = null
  /** Clock time the next un-queued loop iteration starts; null = not cycling. */
  private loopNextIterationSec: number | null = null
  private loopTimer: ReturnType<typeof setInterval> | null = null
  private nextBeatIndex = 0
  /** The metronome's own anchor — re-based on each loop wrap. */
  private metroAnchorTicks = 0
  private metroAnchorSec = 0
  private lastMetroPosition = 0

  private prevTracks: ProjectState['tracks']
  private prevClips: ProjectState['clips']
  private prevTempo: number
  private prevAutomation: ProjectState['automation']
  private prevMasterVolume: number
  private prevNotes: ProjectState['notes']
  private prevPlugins: ProjectState['plugins']

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
    this.prevNotes = store.state.notes
    this.prevPlugins = store.state.plugins
    store.subscribe(this.onStateChanged)
    assets.subscribe(this.onAssetsChanged)
    transport.onEvent(this.onTransportEvent)
    // A provider registering later (plugin installed mid-session) rewires
    // chains so placeholders come alive without any document change.
    pluginRegistry.subscribe(() => {
      if (this.ctx) this.syncPlugins()
    })
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
    this.syncPlugins()
    void this.applyOutputDevice()
    return ctx
  }

  // ---------- Output device ----------

  /**
   * Route audio to a specific output device (null = system default) via
   * AudioContext.setSinkId — live, no restart. Remembered even before the
   * context exists. Resolves false where unsupported or the device is gone.
   */
  async setOutputDevice(deviceId: string | null): Promise<boolean> {
    this.outputDeviceId = deviceId
    return this.applyOutputDevice()
  }

  /** Info for the audio settings panel; null until a context exists. */
  contextInfo(): { sampleRate: number; outputChannels: number; baseLatencySec: number | null } | null {
    if (!this.ctx) return null
    return {
      sampleRate: this.ctx.sampleRate,
      outputChannels: this.ctx.destination.maxChannelCount,
      baseLatencySec: typeof this.ctx.baseLatency === 'number' ? this.ctx.baseLatency : null
    }
  }

  private async applyOutputDevice(): Promise<boolean> {
    // setSinkId is Chromium-era; feature-detect so the plain-browser build
    // (and older engines) degrade to the default device silently.
    const ctx = this.ctx as (AudioContext & { setSinkId?(id: string): Promise<void> }) | null
    if (!ctx?.setSinkId) return this.outputDeviceId === null
    try {
      await ctx.setSinkId(this.outputDeviceId ?? '')
      return true
    } catch {
      return false
    }
  }

  /**
   * Route live input into a track so the performer hears themselves —
   * through the track's own inserts, fader and pan, exactly like playback.
   * Pass null to stop monitoring. The engine owns the connection so a
   * deleted track can never leave a monitor dangling.
   */
  setMonitorSource(trackId: TrackId, node: AudioNode | null): void {
    const previous = this.monitors.get(trackId)
    if (previous) {
      try {
        previous.disconnect(this.chain(trackId).input)
      } catch {
        // chain already torn down — nothing to detach
      }
      this.monitors.delete(trackId)
    }
    if (node) {
      node.connect(this.chain(trackId).input)
      this.monitors.set(trackId, node)
    }
  }

  isMonitoring(trackId: TrackId): boolean {
    return this.monitors.has(trackId)
  }

  /** Live-preview a plugin knob while dragging (no op until release). */
  previewPluginParam(instanceId: PluginInstanceId, param: string, value: number): void {
    const ctx = this.ctx
    const instance = this.store.state.plugins[instanceId]
    const nodes = this.fxNodes.get(instanceId)
    if (ctx && instance && nodes) {
      nodes.apply({ ...instance.params, [param]: value }, ctx.currentTime)
    }
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

  /**
   * Instantaneous peak level for one track, 0..1 (post fader and pan).
   * Zero when the engine is idle or the track has no chain yet — reading
   * it never creates one, so meters cost nothing on silent projects.
   */
  trackLevel(trackId: TrackId): number {
    const chain = this.chains.get(trackId)
    if (!chain) return 0
    chain.analyser.getFloatTimeDomainData(chain.meterBuf)
    let peak = 0
    for (let i = 0; i < chain.meterBuf.length; i++) {
      const v = Math.abs(chain.meterBuf[i])
      if (v > peak) peak = v
    }
    return Math.min(1, peak)
  }

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
      this.stopLoopScheduler()
      return
    }
    if (event === 'seek' && !this.transport.isPlaying) return

    const ctx = this.ensureContext()
    const go = (): void => {
      this.stopAllSources()
      this.reanchor()
      this.scheduleAll()
      this.scheduleAutomation()
      this.startMetronome()
      this.startLoopScheduler()
    }
    if (ctx.state === 'suspended') void ctx.resume().then(go)
    else go()
  }

  /**
   * Keeps the queue of loop iterations topped up while cycling. Only the
   * horizon extends here — already-queued sources keep their exact start
   * times, so a timer running late can never dent the loop's timing.
   */
  private startLoopScheduler(): void {
    if (this.loopTimer !== null) return
    this.loopTimer = setInterval(() => {
      if (!this.transport.isPlaying || !this.transport.activeLoop()) return
      this.topUpLoopIterations()
      this.resyncMetronomeIfWrapped()
    }, LOOP_INTERVAL_MS)
  }

  private stopLoopScheduler(): void {
    if (this.loopTimer !== null) clearInterval(this.loopTimer)
    this.loopTimer = null
    this.loopNextIterationSec = null
  }

  /**
   * The metronome counts beats linearly from its anchor, which a wrap
   * invalidates — re-anchor it to the (wrapped) position when the playhead
   * jumps back. Clicks are only queued ~150 ms ahead, so the correction is
   * inaudible.
   */
  private resyncMetronomeIfWrapped(): void {
    const ctx = this.ctx
    if (!ctx || !this.metroEnabled) return
    const position = this.transport.positionTicks()
    if (position >= this.lastMetroPosition) {
      this.lastMetroPosition = position
      return
    }
    this.lastMetroPosition = position
    this.metroAnchorTicks = position
    this.metroAnchorSec = ctx.currentTime
    this.nextBeatIndex = beatIndexAt(this.store.state, position)
  }

  private onStateChanged = (): void => {
    const state = this.store.state
    // Synth param edits must reschedule voices (envelopes bake params in);
    // freeze flips swap a track between live processing and its render.
    let synthChanged = false
    let frozenChanged = false
    if (state.tracks !== this.prevTracks) {
      for (const [id, track] of Object.entries(state.tracks)) {
        const prev = this.prevTracks[id]
        if (prev && prev.synth !== track.synth) synthChanged = true
        if (prev && prev.frozenAssetId !== track.frozenAssetId) frozenChanged = true
      }
    }
    if (state.tracks !== this.prevTracks || state.masterVolume !== this.prevMasterVolume) {
      this.prevTracks = state.tracks
      this.prevMasterVolume = state.masterVolume
      if (this.ctx) {
        this.syncMixer()
        // Freeze/unfreeze re-wires inserts (bypass vs live).
        if (frozenChanged) this.syncPlugins()
      }
    }
    if (state.plugins !== this.prevPlugins) {
      this.prevPlugins = state.plugins
      if (this.ctx) this.syncPlugins()
    }
    const automationEdited = state.automation !== this.prevAutomation
    this.prevAutomation = state.automation
    if (automationEdited && this.transport.isPlaying && this.ctx) {
      this.scheduleAutomation()
    }
    const editedAudio =
      state.clips !== this.prevClips ||
      state.tempo !== this.prevTempo ||
      state.notes !== this.prevNotes ||
      synthChanged ||
      frozenChanged
    this.prevClips = state.clips
    this.prevTempo = state.tempo
    this.prevNotes = state.notes
    // Reschedule only when something audible changed; unrelated ops
    // (renames etc.) must never interrupt playback.
    if (editedAudio && this.transport.isPlaying && this.ctx) {
      this.stopAllSources()
      this.reanchor()
      this.scheduleAll()
      if (frozenChanged) this.scheduleAutomation() // baked automation goes neutral
      this.resyncMetronome()
    }
  }

  private onAssetsChanged = (): void => {
    // A newly decoded asset may belong to an already-scheduled silent clip.
    if (this.transport.isPlaying && this.ctx) {
      this.stopAllSources()
      this.reanchor()
      this.scheduleAll()
    }
  }

  // ---------- Internals ----------

  private reanchor(): void {
    if (!this.ctx) return
    this.anchorSec = this.ctx.currentTime
    this.anchorTicks = this.transport.positionTicks()
  }

  /**
   * Queue the audio for one pass: from `fromTicks` at clock time `atSec`,
   * up to `untilTicks`. Loop iterations are just repeated passes anchored
   * at their exact wrap times, which is what makes cycling sample-accurate
   * instead of dependent on a timer firing on time.
   */
  private schedulePass(fromTicks: number, atSec: number, untilTicks: number): void {
    this.scheduleClipsPass(fromTicks, atSec, untilTicks)
    this.scheduleNotesPass(fromTicks, atSec, untilTicks)
  }

  /**
   * Everything upcoming: the current pass, plus — when cycling — as many
   * whole iterations as fit in the lookahead window. Called on play/seek
   * and on audible edits.
   */
  private scheduleAll(): void {
    const loop = this.transport.activeLoop()
    if (!loop) {
      this.loopNextIterationSec = null
      this.schedulePass(this.anchorTicks, this.anchorSec, Number.POSITIVE_INFINITY)
      return
    }
    const tps = ticksPerSecond(this.store.state.tempo)
    // The playhead may still be running up to the region; that part plays
    // once, and the first wrap happens when it reaches the region's end.
    this.schedulePass(this.anchorTicks, this.anchorSec, loop.end)
    this.loopNextIterationSec = this.anchorSec + (loop.end - this.anchorTicks) / tps
    this.topUpLoopIterations()
  }

  /** Queue whole iterations until the lookahead window is covered. */
  private topUpLoopIterations(): void {
    const ctx = this.ctx
    const loop = this.transport.activeLoop()
    if (!ctx || !loop || this.loopNextIterationSec === null) return
    const tps = ticksPerSecond(this.store.state.tempo)
    const spanSec = (loop.end - loop.start) / tps
    if (spanSec <= 0) return
    const horizon = ctx.currentTime + LOOP_LOOKAHEAD_SEC
    let guard = 0
    while (this.loopNextIterationSec < horizon && guard++ < 64) {
      this.schedulePass(loop.start, this.loopNextIterationSec, loop.end)
      this.loopNextIterationSec += spanSec
    }
  }

  private scheduleClipsPass(fromTicks: number, atSec: number, untilTicks: number): void {
    const ctx = this.ctx
    if (!ctx) return
    const state = this.store.state
    const schedules = scheduleClips(
      state,
      (id) => this.assets.getSeconds(id),
      fromTicks,
      atSec,
      untilTicks
    )
    // One envelope gain per faded clip in this pass.
    const fadeGains = new Map<string, GainNode>()
    for (const s of schedules) {
      const asset = this.assets.get(s.assetId)
      if (!asset?.buffer) continue
      const buffer = s.reverse ? this.reversedBufferFor(ctx, s.assetId) : asset.buffer
      if (!buffer) continue
      const source = ctx.createBufferSource()
      source.buffer = buffer
      // Resampling: pitch and stretch both land here (see clipRate).
      if (s.rate !== 1) source.playbackRate.value = s.rate
      let dest: AudioNode = this.chain(s.trackId).input
      const clip = state.clips[s.clipId]
      if (clip && (clip.fadeIn > 0 || clip.fadeOut > 0)) {
        let gain = fadeGains.get(s.clipId)
        if (!gain) {
          gain = ctx.createGain()
          gain.connect(dest)
          // Fades are relative to THIS pass's anchor, so a looped clip fades
          // identically on every iteration.
          applyClipFades(gain.gain, clip, state.tempo, fromTicks, atSec)
          fadeGains.set(s.clipId, gain)
          this.fadeNodes.add(gain)
        }
        dest = gain
      }
      source.connect(dest)
      source.onended = () => this.sources.delete(source)
      source.start(s.when, s.offsetSec, s.durationSec)
      this.sources.add(source)
    }
  }

  /**
   * Schedule synth voices for upcoming MIDI notes. Each voice: two detuned
   * saws → lowpass → ADSR gain, into the track chain (so fader, automation,
   * pan, mute/solo all apply). Envelope times are absolute clock times, so
   * voices are sample-accurate like clip sources.
   */
  private scheduleNotesPass(fromTicks: number, atSec: number, untilTicks: number): void {
    const ctx = this.ctx
    if (!ctx) return
    for (const s of scheduleNotes(this.store.state, fromTicks, atSec, untilTicks)) {
      const dest = this.chain(s.trackId).input
      const voices = buildSynthVoice(
        ctx,
        dest,
        s,
        this.store.state.tracks[s.trackId]?.synth ?? {},
        (osc) => this.sources.delete(osc)
      )
      for (const osc of voices) this.sources.add(osc)
    }
  }

  /** Compile volume + pan automation to linear ramps from the current position. */
  private scheduleAutomation(): void {
    const ctx = this.ctx
    if (!ctx) return
    const state = this.store.state
    const tps = ticksPerSecond(state.tempo)
    const now = ctx.currentTime
    const nowTicks = this.anchorTicks + (now - this.anchorSec) * tps
    const rampTime = (ticks: number): number => this.anchorSec + (ticks - this.anchorTicks) / tps

    for (const trackId of Object.keys(state.tracks)) {
      const chain = this.chain(trackId)
      chain.auto.gain.cancelScheduledValues(now)
      // Frozen tracks baked their volume automation into the render.
      const points = state.tracks[trackId]?.frozenAssetId
        ? []
        : automationOf(state, trackId, 'volume')
      chain.auto.gain.setValueAtTime(points.length > 0 ? automationValueAt(points, nowTicks) : 1, now)
      for (const point of points) {
        if (point.ticks <= nowTicks) continue
        chain.auto.gain.linearRampToValueAtTime(point.value, rampTime(point.ticks))
      }

      // Pan automation owns the panner while points exist (0..1 → -1..1);
      // when the last point is deleted mid-playback the knob takes back over.
      const panPoints = automationOf(state, trackId, 'pan')
      chain.panner.pan.cancelScheduledValues(now)
      if (panPoints.length > 0) {
        chain.panner.pan.setValueAtTime(automationValueAt(panPoints, nowTicks) * 2 - 1, now)
        for (const point of panPoints) {
          if (point.ticks <= nowTicks) continue
          chain.panner.pan.linearRampToValueAtTime(point.value * 2 - 1, rampTime(point.ticks))
        }
      } else {
        chain.panner.pan.setValueAtTime(state.tracks[trackId]?.pan ?? 0, now)
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
    for (const gain of this.fadeNodes) gain.disconnect()
    this.fadeNodes.clear()
  }

  private chain(trackId: TrackId): TrackChain {
    const existing = this.chains.get(trackId)
    if (existing) return existing
    const ctx = this.ensureContext()
    const input = ctx.createGain()
    const auto = ctx.createGain()
    const fader = ctx.createGain()
    const panner = ctx.createStereoPanner()
    fader.gain.value = this.effectiveGain(trackId)
    panner.pan.value = this.store.state.tracks[trackId]?.pan ?? 0
    input.connect(auto)
    auto.connect(fader)
    fader.connect(panner)
    const parentId = this.store.state.tracks[trackId]?.parentId ?? null
    panner.connect(this.busFor(parentId))
    // Metering is a side-tap: the analyser has no onward connection, so it
    // observes the post-fader/pan signal without altering the path.
    const analyser = ctx.createAnalyser()
    analyser.fftSize = 1024
    panner.connect(analyser)
    const chain: TrackChain = {
      input,
      auto,
      fader,
      panner,
      analyser,
      meterBuf: new Float32Array(analyser.fftSize),
      parentId
    }
    this.chains.set(trackId, chain)
    this.wireInserts(trackId, chain)
    return chain
  }

  /** Where a track's output goes: its folder's chain input, or master. */
  private busFor(parentId: TrackId | null): AudioNode {
    if (parentId !== null && this.store.state.tracks[parentId]) {
      return this.chain(parentId).input
    }
    return this.master!
  }

  /**
   * Reconcile plugin node instances with document state and (re)wire each
   * track's insert path: input → enabled plugins in rank order → auto.
   * Node instances persist across unrelated changes so params don't
   * zipper. Unresolvable plugins (MISSING on this client) are bypassed —
   * a missing plugin never breaks playback or the project.
   */
  private syncPlugins(): void {
    const ctx = this.ctx
    if (!ctx) return
    const state = this.store.state
    for (const [instanceId, nodes] of this.fxNodes) {
      if (!state.plugins[instanceId]) {
        nodes.dispose()
        this.fxNodes.delete(instanceId)
      }
    }
    for (const [trackId, chain] of this.chains) this.wireInserts(trackId, chain)
  }

  private wireInserts(trackId: TrackId, chain: TrackChain): void {
    const ctx = this.ctx
    if (!ctx) return
    const now = ctx.currentTime
    const inserts = pluginsOfTrack(this.store.state, trackId)

    chain.input.disconnect()
    for (const instance of inserts) {
      this.fxNodes.get(instance.id)?.output.disconnect()
    }

    // A frozen track's render already contains its inserts — bypass them
    // all (this is where the CPU is saved; nodes stay alive for unfreeze).
    if (this.store.state.tracks[trackId]?.frozenAssetId) {
      chain.input.connect(chain.auto)
      return
    }

    let prev: AudioNode = chain.input
    for (const instance of inserts) {
      if (!instance.enabled) continue
      let nodes = this.fxNodes.get(instance.id)
      if (!nodes) {
        const resolved = pluginRegistry.resolve(instance.descriptor)
        if (!resolved) continue // MISSING here: bypass until a provider appears
        nodes = resolved.provider.create(ctx)
        this.fxNodes.set(instance.id, nodes)
      }
      nodes.apply(instance.params, now)
      prev.connect(nodes.input)
      prev = nodes.output
    }
    prev.connect(chain.auto)
  }

  /** Mirrored buffer for reversed clips, allocated by the asset store's cache. */
  private reversedBufferFor(ctx: BaseAudioContext, assetId: string): AudioBuffer | null {
    return this.assets.reversedBuffer(assetId, (channels, sampleRate) => {
      const buffer = ctx.createBuffer(channels.length, channels[0].length, sampleRate)
      channels.forEach((data, ch) => buffer.copyToChannel(data as Float32Array<ArrayBuffer>, ch))
      return buffer
    })
  }

  private hasPanAutomation(trackId: TrackId): boolean {
    return Object.values(this.store.state.automation).some(
      (p) => p.trackId === trackId && p.param === 'pan'
    )
  }

  private isAudible(trackId: TrackId): boolean {
    return isTrackAudible(this.store.state, trackId)
  }

  /** Fader gain: track volume, or 0 when muted / not solo-relevant while solo is on. */
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
        this.monitors.get(trackId)?.disconnect()
        this.monitors.delete(trackId)
        chain.input.disconnect()
        chain.auto.disconnect()
        chain.fader.disconnect()
        chain.panner.disconnect()
        chain.analyser.disconnect()
        for (const instance of Object.values(this.prevPlugins)) {
          if (instance.trackId === trackId) {
            this.fxNodes.get(instance.id)?.dispose()
            this.fxNodes.delete(instance.id)
          }
        }
        this.chains.delete(trackId)
        continue
      }
      chain.fader.gain.setTargetAtTime(this.effectiveGain(trackId), now, GAIN_SMOOTHING_SEC)
      // While pan automation is playing, its ramps own the panner.
      if (!(this.transport.isPlaying && this.hasPanAutomation(trackId))) {
        chain.panner.pan.setTargetAtTime(track.pan, now, GAIN_SMOOTHING_SEC)
      }
    }
    for (const trackId of Object.keys(this.store.state.tracks)) {
      if (!this.chains.has(trackId)) this.chain(trackId)
    }
    // Re-route outputs whose folder changed (drag into/out of a folder).
    for (const [trackId, chain] of this.chains) {
      const parentId = this.store.state.tracks[trackId]?.parentId ?? null
      if (parentId !== chain.parentId) {
        chain.panner.disconnect()
        chain.panner.connect(this.busFor(parentId))
        chain.panner.connect(chain.analyser) // keep the meter tap
        chain.parentId = parentId
      }
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
    const position = this.transport.positionTicks()
    this.nextBeatIndex = beatIndexAt(this.store.state, position)
    // The metronome keeps its own anchor because cycling moves the playhead
    // backwards, which the clip anchor deliberately does not follow.
    this.metroAnchorTicks = this.anchorTicks
    this.metroAnchorSec = this.anchorSec
    this.lastMetroPosition = position
  }

  private metroTick = (): void => {
    const ctx = this.ctx
    if (!ctx || !this.metroEnabled || !this.transport.isPlaying) return
    const now = ctx.currentTime
    const { clicks, nextBeatIndex } = metronomeClicks(
      this.store.state,
      this.metroAnchorTicks,
      this.metroAnchorSec,
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
