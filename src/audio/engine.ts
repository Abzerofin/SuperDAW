import type { PluginInstance, PluginInstanceId, ProjectState, Route, TrackId } from '@core/model/types'
import {
  automationOf,
  automationValueAt,
  isTrackAudible,
  pluginsOfTrack,
  routesOfTrack
} from '@core/model/types'
import type { AutomationPoint } from '@core/model/types'
import { ticksPerBeat } from '@core/model/timebase'
import { denormalizeParam } from '@core/model/effects'
import { paramDefsOf } from '@core/plugins/builtin'
import type { AssetStore } from './assets'
import { applyClipFades } from './fades'
import { LivePreview } from './livePreview'
import { pluginRegistry, type PluginAnalysis, type PluginNodes } from './pluginRegistry'
import type { ExternalPluginHost } from './render'
import { RENDER_SAMPLE_RATE } from './render'
import { buildSynthVoice } from './synth'
import {
  beatIndexAt,
  metronomeClicks,
  scheduleClips,
  scheduleNotes,
  ticksPerSecond,
  trackLoopRepeatState,
  trackLoopSpan
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
/**
 * Insert-effect parameter automation is applied by sampling the curves on
 * this cadence and pushing values through PluginNodes.apply (whose 20 ms
 * smoothing turns the steps into inaudible glides). Time-driven rather
 * than pre-scheduled: builtin nodes expose no per-param AudioParam handles
 * to ramp, and sampling live state makes mid-play edits just work.
 */
const FX_AUTO_INTERVAL_MS = 50

/** Seconds of finished VST3 audio produced per window. Also the latency. */
const PREVIEW_WINDOW_SEC = 2
/** How far ahead of the playhead preview audio is kept queued. */
const PREVIEW_LOOKAHEAD_SEC = 4
const PREVIEW_INTERVAL_MS = 250

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
  /**
   * Per-instance inlet/outlet gains for GRAPH-routed tracks. Routing edges
   * connect outlets to inlets; a bypassed/missing plugin just shorts its
   * inlet to its outlet, so every graph shape degrades gracefully.
   */
  private graphPorts = new Map<PluginInstanceId, { inlet: GainNode; outlet: GainNode }>()
  /** Everything currently scheduled: clip buffer sources AND synth oscillators. */
  private sources = new Set<AudioScheduledSourceNode>()
  /** Per-clip fade envelope gains for the current scheduling pass. */
  private fadeNodes = new Set<GainNode>()
  /** Live input monitors feeding track chains, by track. */
  private monitors = new Map<TrackId, AudioNode>()

  /**
   * Live VST3 preview. Tracks in `previewTracks` have their clips and
   * synth voices SUPPRESSED — their audio arrives instead as finished
   * windows produced out of process, injected post-inserts at `auto` (the
   * builtins are already baked into each window).
   */
  private preview: LivePreview | null = null
  private previewTracks = new Set<TrackId>()
  /** Next window start, per track: timeline ticks and its clock time. */
  private previewNextTicks = new Map<TrackId, number>()
  private previewNextSec = new Map<TrackId, number>()
  private previewTimer: ReturnType<typeof setInterval> | null = null
  private previewFilling = false
  /** Bumped on teardown so an in-flight render cannot schedule stale audio. */
  private previewGeneration = 0

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
  /**
   * Per-user track loops: each track in the set repeats its own material
   * indefinitely while every other track plays the timeline as written —
   * for auditioning a melody against the rest of the song. Ephemeral, never
   * part of the document. Replaced (not mutated) on change so React
   * subscribers can snapshot it.
   */
  private trackLoops: ReadonlySet<TrackId> = new Set()
  private trackLoopListeners = new Set<() => void>()
  private trackLoopTimer: ReturnType<typeof setInterval> | null = null
  /** Next un-queued ghost-repeat index per looping track. */
  private trackLoopNextRepeat = new Map<TrackId, number>()
  /** Samples insert-param automation while playing (see FX_AUTO_INTERVAL_MS). */
  private fxAutoTimer: ReturnType<typeof setInterval> | null = null
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
  private prevRoutes: ProjectState['routes']

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
    this.prevRoutes = store.state.routes
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
    this.previewPluginParams(instanceId, { [param]: value })
  }

  /**
   * Live-preview several params at once — gestures like dragging an EQ
   * band point move freq and gain together (still no op until release).
   */
  previewPluginParams(
    instanceId: PluginInstanceId,
    partial: Readonly<Record<string, number>>
  ): void {
    const ctx = this.ctx
    const instance = this.store.state.plugins[instanceId]
    const nodes = this.fxNodes.get(instanceId)
    if (ctx && instance && nodes) {
      nodes.apply({ ...instance.params, ...partial }, ctx.currentTime)
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

  /**
   * Live analysis handle for a plugin instance (spectrum tap, gain
   * reduction…), or null while its nodes are not in the graph (context not
   * started, plugin bypassed, track frozen). Read-only; polled by the FX
   * cards' rAF loops, never through React state.
   */
  pluginAnalysis(instanceId: PluginInstanceId): PluginAnalysis | null {
    return this.fxNodes.get(instanceId)?.analysis ?? null
  }

  /**
   * Time-domain analyser for a routing-graph wire's SOURCE: an insert's
   * output rides its existing internal analyser tap; the 'in' terminal
   * gets a lazy tap on the track chain's input, keyed by the input node
   * itself so a chain rebuild simply mints a fresh tap. Feeds the graph
   * view's wire oscilloscopes; costs nothing until the view asks.
   */
  private inputWaveTaps = new WeakMap<GainNode, AnalyserNode>()

  graphSourceAnalyser(trackId: TrackId, from: 'in' | PluginInstanceId): AnalyserNode | null {
    if (from !== 'in') return this.fxNodes.get(from)?.analysis?.spectrum ?? null
    const ctx = this.ctx
    if (!ctx) return null
    const chain = this.chains.get(trackId)
    if (!chain) return null
    let tap = this.inputWaveTaps.get(chain.input)
    if (!tap) {
      tap = ctx.createAnalyser()
      tap.fftSize = 1024
      chain.input.connect(tap)
      this.inputWaveTaps.set(chain.input, tap)
    }
    return tap
  }

  // ---------- Transport / state reactions ----------

  private onTransportEvent = (event: 'play' | 'stop' | 'seek'): void => {
    if (event === 'stop') {
      this.stopAllSources()
      this.teardownPreview()
      this.stopMetronome()
      this.stopLoopScheduler()
      this.stopTrackLoopScheduler()
      this.stopFxAutomation()
      return
    }
    if (event === 'seek' && !this.transport.isPlaying) return

    const ctx = this.ensureContext()
    const go = (): void => {
      void this.restart(() => {
        this.startMetronome()
        this.startLoopScheduler()
        this.startTrackLoopScheduler()
        this.startFxAutomation()
      })
    }
    if (ctx.state === 'suspended') void ctx.resume().then(go)
    else go()
  }

  /**
   * Re-queue everything from the current position. Preview audio must be
   * rendered BEFORE the anchor is taken, because producing the first
   * window costs real time — the render is then started at an offset so
   * the previewed track stays in sync with everything else rather than
   * arriving late by however long it took.
   */
  private async restart(after: () => void): Promise<void> {
    this.stopAllSources()
    this.teardownPreview()
    const generation = this.previewGeneration
    const first = await this.preparePreview()
    // Stopped or superseded while rendering: drop it on the floor.
    if (generation !== this.previewGeneration || !this.ctx) return
    this.reanchor()
    // Clear automation BEFORE the passes arm it: cancelScheduledValues
    // would otherwise wipe what they just queued.
    this.resetAutomation()
    this.scheduleAll()
    after()
    this.emitFirstPreviewWindows(first)
    this.startPreviewScheduler()
  }

  // ---------- Live VST3 preview ----------

  /**
   * Supply the out-of-process plugin host. Injected so this module stays
   * free of Electron; without it (browser build) external inserts simply
   * stay silent until the track is frozen, as before.
   */
  setExternalHost(host: ExternalPluginHost | null): void {
    this.teardownPreview()
    this.preview = host ? new LivePreview(this.store, this.assets, host) : null
  }

  /**
   * Open the plugins and render each eligible track's FIRST window, before
   * an anchor exists. Returns the buffers with the tick they start at, so
   * the caller can offset them against the anchor it then takes.
   */
  private async preparePreview(): Promise<Map<TrackId, { buffer: AudioBuffer; fromTicks: number }>> {
    const out = new Map<TrackId, { buffer: AudioBuffer; fromTicks: number }>()
    const ctx = this.ctx
    this.previewTracks = new Set()
    if (!ctx || !this.preview || !this.transport.isPlaying) return out
    // Preview windows advance linearly and cannot wrap, so while the cycle
    // region is active previewed tracks would sail past the loop end.
    // They play dry instead (builtins live, VST3 bypassed) — as before
    // this feature existed.
    if (this.transport.activeLoop()) return out

    const generation = this.previewGeneration
    const tracks = this.preview.eligibleTracks()
    if (tracks.length === 0) return out

    const fromTicks = this.transport.positionTicks()
    const untilTicks =
      fromTicks + Math.ceil(PREVIEW_WINDOW_SEC * ticksPerSecond(this.store.state.tempo))

    for (const trackId of tracks) {
      // Windows are produced at the offline render rate; opening the plugin
      // at the device rate would feed e.g. a 48 kHz-configured plugin
      // 44.1 kHz material — audibly wrong for anything pitch- or
      // time-aware. The engine resamples the returned buffer on playback.
      if (!(await this.preview.open(trackId, RENDER_SAMPLE_RATE))) continue
      const buffer = await this.preview.renderWindow(trackId, fromTicks, untilTicks)
      if (generation !== this.previewGeneration) return new Map()
      if (!buffer) continue
      // Only now is the track's own audio suppressed — if rendering failed
      // it must keep playing dry rather than fall silent.
      this.previewTracks.add(trackId)
      this.previewNextTicks.set(trackId, untilTicks)
      out.set(trackId, { buffer, fromTicks })
    }
    return out
  }

  /** Start the prepared windows, skipping whatever elapsed while rendering. */
  private emitFirstPreviewWindows(
    first: Map<TrackId, { buffer: AudioBuffer; fromTicks: number }>
  ): void {
    const tps = ticksPerSecond(this.store.state.tempo)
    for (const [trackId, { buffer, fromTicks }] of first) {
      const skipSec = Math.max(0, (this.anchorTicks - fromTicks) / tps)
      if (skipSec >= buffer.duration) continue // window entirely in the past
      this.schedulePreviewBuffer(trackId, buffer, this.anchorSec, skipSec)
      this.previewNextSec.set(trackId, this.anchorSec + (buffer.duration - skipSec))
    }
  }

  private schedulePreviewBuffer(
    trackId: TrackId,
    buffer: AudioBuffer,
    when: number,
    offsetSec = 0
  ): void {
    const ctx = this.ctx
    if (!ctx) return
    const source = ctx.createBufferSource()
    source.buffer = buffer
    // Injected AFTER the inserts: the builtins are already baked into the
    // window, while `auto` still applies live volume automation.
    source.connect(this.chain(trackId).auto)
    source.onended = () => this.sources.delete(source)
    source.start(when, offsetSec)
    this.sources.add(source)
  }

  private startPreviewScheduler(): void {
    if (this.previewTimer !== null || this.previewTracks.size === 0) return
    this.previewTimer = setInterval(() => void this.topUpPreview(), PREVIEW_INTERVAL_MS)
  }

  /** Render and queue windows until the lookahead horizon is covered. */
  private async topUpPreview(): Promise<void> {
    const ctx = this.ctx
    if (!ctx || !this.preview || !this.transport.isPlaying) return
    // A loop region appeared mid-play: preview cannot wrap, so restart —
    // preparePreview will then decline and the tracks fall back to dry.
    if (this.transport.activeLoop()) {
      void this.restart(() => this.resyncMetronome())
      return
    }
    // Renders are slow; never let two overlap for the same window.
    if (this.previewFilling) return
    this.previewFilling = true
    const generation = this.previewGeneration
    try {
      const tps = ticksPerSecond(this.store.state.tempo)
      const windowTicks = Math.ceil(PREVIEW_WINDOW_SEC * tps)
      for (const trackId of this.previewTracks) {
        let guard = 0
        while (
          (this.previewNextSec.get(trackId) ?? 0) < ctx.currentTime + PREVIEW_LOOKAHEAD_SEC &&
          guard++ < 4
        ) {
          const fromTicks = this.previewNextTicks.get(trackId) ?? 0
          const buffer = await this.preview.renderWindow(
            trackId,
            fromTicks,
            fromTicks + windowTicks
          )
          if (generation !== this.previewGeneration || !this.ctx) return
          if (!buffer) break // past the end of the material
          const when = this.previewNextSec.get(trackId) ?? ctx.currentTime
          // Falling behind: drop the window rather than schedule the past.
          if (when > ctx.currentTime) this.schedulePreviewBuffer(trackId, buffer, when)
          this.previewNextSec.set(trackId, when + buffer.duration)
          this.previewNextTicks.set(trackId, fromTicks + windowTicks)
        }
      }
    } finally {
      this.previewFilling = false
    }
  }

  private teardownPreview(): void {
    this.previewGeneration++
    if (this.previewTimer !== null) clearInterval(this.previewTimer)
    this.previewTimer = null
    this.previewFilling = false
    this.previewTracks.clear()
    this.previewNextTicks.clear()
    this.previewNextSec.clear()
    this.preview?.closeAll()
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

  // ---------- Track loops ----------

  isTrackLooping(trackId: TrackId): boolean {
    return this.trackLoops.has(trackId)
  }

  subscribeTrackLoops = (listener: () => void): (() => void) => {
    this.trackLoopListeners.add(listener)
    return () => this.trackLoopListeners.delete(listener)
  }

  /**
   * Toggle a track's own loop. Frozen tracks are left alone (their render
   * plays as one source from tick 0 and cannot be re-anchored per repeat).
   */
  setTrackLoop(trackId: TrackId, on: boolean): void {
    if (this.trackLoops.has(trackId) === on) return
    if (on && this.store.state.tracks[trackId]?.frozenAssetId) return
    const next = new Set(this.trackLoops)
    if (on) next.add(trackId)
    else next.delete(trackId)
    this.trackLoops = next
    for (const listener of this.trackLoopListeners) listener()
    if (this.transport.isPlaying && this.ctx) {
      void this.restart(() => {})
      this.startTrackLoopScheduler()
    }
  }

  private startTrackLoopScheduler(): void {
    if (this.trackLoopTimer !== null) return
    this.trackLoopTimer = setInterval(() => {
      if (!this.transport.isPlaying) return
      this.topUpTrackLoops()
    }, LOOP_INTERVAL_MS)
  }

  private stopTrackLoopScheduler(): void {
    if (this.trackLoopTimer !== null) clearInterval(this.trackLoopTimer)
    this.trackLoopTimer = null
    this.trackLoopNextRepeat.clear()
  }

  // ---------- Insert-parameter automation ----------

  private startFxAutomation(): void {
    if (this.fxAutoTimer !== null) return
    this.fxAutoTimer = setInterval(() => this.applyFxAutomation(), FX_AUTO_INTERVAL_MS)
  }

  private stopFxAutomation(): void {
    if (this.fxAutoTimer !== null) clearInterval(this.fxAutoTimer)
    this.fxAutoTimer = null
    // Settle every automated insert back onto its stored params, so a
    // stopped transport leaves the knobs meaning what they say.
    const ctx = this.ctx
    if (!ctx) return
    const state = this.store.state
    for (const point of Object.values(state.automation)) {
      if (point.instanceId === undefined) continue
      const instance = state.plugins[point.instanceId]
      if (instance) this.fxNodes.get(instance.id)?.apply(instance.params, ctx.currentTime)
    }
  }

  /** Push each automated insert param's curve value into its live nodes. */
  private applyFxAutomation(): void {
    const ctx = this.ctx
    if (!ctx || !this.transport.isPlaying) return
    const state = this.store.state
    // Group plugin-param points; skip everything when there are none.
    let groups: Map<PluginInstanceId, Map<string, AutomationPoint[]>> | null = null
    for (const point of Object.values(state.automation)) {
      if (point.instanceId === undefined) continue
      groups ??= new Map()
      let params = groups.get(point.instanceId)
      if (!params) groups.set(point.instanceId, (params = new Map()))
      const list = params.get(point.param)
      if (list) list.push(point)
      else params.set(point.param, [point])
    }
    if (!groups) return
    const nowTicks = this.transport.positionTicks()
    for (const [instanceId, params] of groups) {
      const instance = state.plugins[instanceId]
      if (!instance || !instance.enabled) continue
      if (state.tracks[instance.trackId]?.frozenAssetId) continue // baked
      const nodes = this.fxNodes.get(instanceId)
      if (!nodes) continue // missing/external plugin: nothing live to drive
      const defs = paramDefsOf(instance.descriptor)
      const merged: Record<string, number> = { ...instance.params }
      for (const [param, points] of params) {
        points.sort((a, b) => a.ticks - b.ticks)
        const v = automationValueAt(points, nowTicks)
        const def = defs?.[param]
        merged[param] = def ? denormalizeParam(def, v) : v
      }
      nodes.apply(merged, ctx.currentTime)
    }
  }

  /**
   * Queue ghost repeats of each looping track until the lookahead horizon
   * is covered. Each repeat is the ordinary schedule math run over a
   * derived state holding only that track's clips shifted one period later
   * — see trackLoopRepeatState. Inactive while the cycle region runs (the
   * region already repeats everything inside it).
   */
  private topUpTrackLoops(): void {
    const ctx = this.ctx
    if (!ctx || this.trackLoops.size === 0 || this.transport.activeLoop()) return
    const state = this.store.state
    const tps = ticksPerSecond(state.tempo)
    const horizonTicks =
      this.anchorTicks + (ctx.currentTime + LOOP_LOOKAHEAD_SEC - this.anchorSec) * tps
    for (const trackId of this.trackLoops) {
      const track = state.tracks[trackId]
      if (!track || track.frozenAssetId !== null) continue
      const span = trackLoopSpan(state, trackId)
      if (!span) continue
      const period = span.end - span.start
      // First repeat still audible at the anchor — repeats fully in the
      // past schedule nothing, so skip straight past them.
      const firstLive = Math.max(
        1,
        Math.floor((this.anchorTicks - span.end) / period) + 1
      )
      let repeat = Math.max(this.trackLoopNextRepeat.get(trackId) ?? 1, firstLive)
      let guard = 0
      while (span.start + repeat * period < horizonTicks && guard++ < 64) {
        const repeatState = trackLoopRepeatState(state, trackId, repeat * period)
        const fadeGains = new Map<string, GainNode>()
        this.scheduleClipsPass(
          this.anchorTicks,
          this.anchorSec,
          Number.POSITIVE_INFINITY,
          fadeGains,
          repeatState
        )
        this.scheduleNotesPass(
          this.anchorTicks,
          this.anchorSec,
          Number.POSITIVE_INFINITY,
          fadeGains,
          repeatState
        )
        repeat++
      }
      this.trackLoopNextRepeat.set(trackId, repeat)
    }
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
    // External-plugin edits change what preview windows SOUND like, so
    // they are audible edits. Builtin edits are not: their nodes apply
    // params live with smoothing and must not interrupt playback.
    let externalPluginChanged = false
    if (state.plugins !== this.prevPlugins) {
      const prev = this.prevPlugins
      for (const [id, instance] of Object.entries(state.plugins)) {
        if (instance.descriptor.format !== 'builtin' && prev[id] !== instance) {
          externalPluginChanged = true
        }
      }
      for (const [id, instance] of Object.entries(prev)) {
        if (instance.descriptor.format !== 'builtin' && !state.plugins[id]) {
          externalPluginChanged = true
        }
      }
      this.prevPlugins = state.plugins
      if (this.ctx) this.syncPlugins()
    }
    // Routing-graph edits rewire chains; on a track previewed through
    // external plugins they also change what the windows sound like.
    let routesChanged = false
    if (state.routes !== this.prevRoutes) {
      routesChanged = true
      this.prevRoutes = state.routes
      if (this.ctx) this.syncPlugins()
    }
    const automationEdited = state.automation !== this.prevAutomation
    this.prevAutomation = state.automation
    if (automationEdited && this.transport.isPlaying && this.ctx) {
      this.rearmAutomation()
    }
    const editedAudio =
      state.clips !== this.prevClips ||
      state.tempo !== this.prevTempo ||
      state.notes !== this.prevNotes ||
      synthChanged ||
      frozenChanged ||
      ((externalPluginChanged || routesChanged) && this.preview !== null)
    this.prevClips = state.clips
    this.prevTempo = state.tempo
    this.prevNotes = state.notes
    // Reschedule only when something audible changed; unrelated ops
    // (renames etc.) must never interrupt playback. Already-rendered
    // preview windows bake the OLD state in, so restart() re-renders them.
    if (editedAudio && this.transport.isPlaying && this.ctx) {
      // restart() resets and re-arms automation itself, so a freeze flip
      // (whose baked automation must go neutral) needs nothing extra here.
      void this.restart(() => this.resyncMetronome())
    }
  }

  private onAssetsChanged = (): void => {
    // A newly decoded asset may belong to an already-scheduled silent clip.
    if (this.transport.isPlaying && this.ctx) {
      void this.restart(() => {})
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
    // Clips and synth voices share one fade envelope per clip, so a MIDI
    // clip tapers exactly like an audio one.
    const fadeGains = new Map<string, GainNode>()
    this.scheduleClipsPass(fromTicks, atSec, untilTicks, fadeGains)
    this.scheduleNotesPass(fromTicks, atSec, untilTicks, fadeGains)
    // Automation rides along so each loop iteration replays it.
    this.scheduleAutomationPass(fromTicks, atSec, untilTicks)
  }

  /**
   * The pass windows currently inside the lookahead — the same set
   * scheduleAll would queue. Used to re-arm automation alone, without
   * restarting clip sources (an automation edit must not glitch playback).
   */
  private upcomingPasses(): Array<[fromTicks: number, atSec: number, untilTicks: number]> {
    const ctx = this.ctx
    if (!ctx) return []
    const loop = this.transport.activeLoop()
    if (!loop) return [[this.anchorTicks, this.anchorSec, Number.POSITIVE_INFINITY]]
    const tps = ticksPerSecond(this.store.state.tempo)
    const spanSec = (loop.end - loop.start) / tps
    const passes: Array<[number, number, number]> = [
      [this.anchorTicks, this.anchorSec, loop.end]
    ]
    if (spanSec <= 0) return passes
    const horizon = ctx.currentTime + LOOP_LOOKAHEAD_SEC
    let at = this.anchorSec + (loop.end - this.anchorTicks) / tps
    let guard = 0
    while (at < horizon && guard++ < 64) {
      passes.push([loop.start, at, loop.end])
      at += spanSec
    }
    return passes
  }

  /**
   * Where a clip's audio should be routed: through its fade envelope when
   * it has one (created lazily per pass), otherwise straight into the
   * track chain.
   */
  private destinationFor(
    clipId: string,
    trackId: TrackId,
    fadeGains: Map<string, GainNode>,
    fromTicks: number,
    atSec: number,
    state: ProjectState = this.store.state
  ): AudioNode {
    const ctx = this.ctx!
    const chainInput = this.chain(trackId).input
    // Looked up in the pass's own state: a track-loop ghost repeat carries
    // shifted clip positions, so its fades land on the repeat, not the
    // original.
    const clip = state.clips[clipId]
    if (!clip || (clip.fadeIn <= 0 && clip.fadeOut <= 0)) return chainInput
    let gain = fadeGains.get(clipId)
    if (!gain) {
      gain = ctx.createGain()
      gain.connect(chainInput)
      // Fades are relative to THIS pass's anchor, so a clip inside a loop
      // region tapers identically on every iteration.
      applyClipFades(gain.gain, clip, state.tempo, fromTicks, atSec)
      fadeGains.set(clipId, gain)
      this.fadeNodes.add(gain)
    }
    return gain
  }

  /**
   * Everything upcoming: the current pass, plus — when cycling — as many
   * whole iterations as fit in the lookahead window. Called on play/seek
   * and on audible edits.
   */
  private scheduleAll(): void {
    this.trackLoopNextRepeat.clear()
    const loop = this.transport.activeLoop()
    if (!loop) {
      this.loopNextIterationSec = null
      this.schedulePass(this.anchorTicks, this.anchorSec, Number.POSITIVE_INFINITY)
      this.topUpTrackLoops()
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

  private scheduleClipsPass(
    fromTicks: number,
    atSec: number,
    untilTicks: number,
    fadeGains: Map<string, GainNode>,
    state: ProjectState = this.store.state
  ): void {
    const ctx = this.ctx
    if (!ctx) return
    const schedules = scheduleClips(
      state,
      (id) => this.assets.getSeconds(id),
      fromTicks,
      atSec,
      untilTicks
    )
    for (const s of schedules) {
      // Previewed tracks: their finished audio (inserts included) arrives
      // as rendered windows — playing the dry clip too would double it.
      if (this.previewTracks.has(s.trackId)) continue
      const asset = this.assets.get(s.assetId)
      if (!asset?.buffer) continue
      const buffer = s.reverse ? this.reversedBufferFor(ctx, s.assetId) : asset.buffer
      if (!buffer) continue
      const source = ctx.createBufferSource()
      source.buffer = buffer
      // Resampling: pitch and stretch both land here (see clipRate).
      if (s.rate !== 1) source.playbackRate.value = s.rate
      const dest = this.destinationFor(s.clipId, s.trackId, fadeGains, fromTicks, atSec, state)
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
  private scheduleNotesPass(
    fromTicks: number,
    atSec: number,
    untilTicks: number,
    fadeGains: Map<string, GainNode>,
    state: ProjectState = this.store.state
  ): void {
    const ctx = this.ctx
    if (!ctx) return
    for (const s of scheduleNotes(state, fromTicks, atSec, untilTicks)) {
      // Previewed tracks get their audio as rendered windows (synth included).
      if (this.previewTracks.has(s.trackId)) continue
      // Voices go through the clip's fade envelope, so MIDI tapers too.
      const dest = this.destinationFor(s.clipId, s.trackId, fadeGains, fromTicks, atSec, state)
      const voices = buildSynthVoice(
        ctx,
        dest,
        s,
        state.tracks[s.trackId]?.synth ?? {},
        (osc) => this.sources.delete(osc)
      )
      for (const osc of voices) this.sources.add(osc)
    }
  }

  /**
   * Drop every scheduled automation event from now, and settle the tracks
   * that have no automation at all onto their static values. Tracks that
   * DO have points get their curve re-armed per pass — see
   * scheduleAutomationPass — so cycling repeats the automation instead of
   * running off the end of the region and holding.
   */
  private resetAutomation(): void {
    const ctx = this.ctx
    if (!ctx) return
    const state = this.store.state
    const now = ctx.currentTime
    for (const trackId of Object.keys(state.tracks)) {
      const chain = this.chain(trackId)
      chain.auto.gain.cancelScheduledValues(now)
      chain.panner.pan.cancelScheduledValues(now)
      // Frozen tracks baked their volume automation into the render.
      const points = state.tracks[trackId]?.frozenAssetId
        ? []
        : automationOf(state, trackId, 'volume')
      if (points.length === 0) chain.auto.gain.setValueAtTime(1, now)
      // Pan automation owns the panner while points exist (0..1 → -1..1);
      // when the last point is deleted mid-playback the knob takes back over.
      if (automationOf(state, trackId, 'pan').length === 0) {
        chain.panner.pan.setValueAtTime(state.tracks[trackId]?.pan ?? 0, now)
      }
    }
  }

  /**
   * Compile volume + pan automation to linear ramps for ONE pass, on the
   * same footing as clips and notes: times are relative to this pass's
   * anchor, so every loop iteration replays the region's automation. Each
   * pass re-enters at the region's own start value — a wrap is a jump, not
   * a ramp from wherever the previous iteration ended.
   */
  private scheduleAutomationPass(fromTicks: number, atSec: number, untilTicks: number): void {
    const state = this.store.state
    const tps = ticksPerSecond(state.tempo)
    const rampTime = (ticks: number): number => atSec + (ticks - fromTicks) / tps

    for (const trackId of Object.keys(state.tracks)) {
      const points = state.tracks[trackId]?.frozenAssetId
        ? []
        : automationOf(state, trackId, 'volume')
      const panPoints = automationOf(state, trackId, 'pan')
      if (points.length === 0 && panPoints.length === 0) continue
      const chain = this.chain(trackId)

      if (points.length > 0) {
        chain.auto.gain.setValueAtTime(automationValueAt(points, fromTicks), atSec)
        for (const point of points) {
          if (point.ticks <= fromTicks || point.ticks > untilTicks) continue
          chain.auto.gain.linearRampToValueAtTime(point.value, rampTime(point.ticks))
        }
      }

      if (panPoints.length > 0) {
        chain.panner.pan.setValueAtTime(automationValueAt(panPoints, fromTicks) * 2 - 1, atSec)
        for (const point of panPoints) {
          if (point.ticks <= fromTicks || point.ticks > untilTicks) continue
          chain.panner.pan.linearRampToValueAtTime(point.value * 2 - 1, rampTime(point.ticks))
        }
      }
    }
  }

  /** Wipe and re-arm automation across every pass already in the window. */
  private rearmAutomation(): void {
    this.resetAutomation()
    for (const [fromTicks, atSec, untilTicks] of this.upcomingPasses()) {
      this.scheduleAutomationPass(fromTicks, atSec, untilTicks)
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
    for (const [instanceId, ports] of this.graphPorts) {
      if (!state.plugins[instanceId]) {
        ports.inlet.disconnect()
        ports.outlet.disconnect()
        this.graphPorts.delete(instanceId)
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
      const ports = this.graphPorts.get(instance.id)
      ports?.inlet.disconnect()
      ports?.outlet.disconnect()
    }

    // A frozen track's render already contains its inserts — bypass them
    // all (this is where the CPU is saved; nodes stay alive for unfreeze).
    if (this.store.state.tracks[trackId]?.frozenAssetId) {
      chain.input.connect(chain.auto)
      return
    }

    const routes = routesOfTrack(this.store.state, trackId)
    if (routes.length > 0) {
      this.wireGraph(chain, inserts, routes, now)
      return
    }

    let prev: AudioNode = chain.input
    for (const instance of inserts) {
      if (!instance.enabled) continue
      const nodes = this.liveNodesFor(instance, now)
      if (!nodes) continue // MISSING here: bypass until a provider appears
      prev.connect(nodes.input)
      prev = nodes.output
    }
    prev.connect(chain.auto)
  }

  /**
   * GRAPH routing: edges connect instance outlets to inlets; 'in' is the
   * track source (chain.input) and 'out' the summing mix node (chain.auto —
   * Web Audio fan-in sums, fan-out is free). Bypassed, missing and
   * external (out-of-process) plugins short inlet→outlet, so signal always
   * flows along the drawn wires. A graph with no path in→out is honestly
   * silent — the editor warns.
   */
  private wireGraph(
    chain: TrackChain,
    inserts: PluginInstance[],
    routes: Route[],
    now: number
  ): void {
    const ctx = this.ctx!
    for (const instance of inserts) {
      let ports = this.graphPorts.get(instance.id)
      if (!ports) {
        ports = { inlet: ctx.createGain(), outlet: ctx.createGain() }
        this.graphPorts.set(instance.id, ports)
      }
      const nodes = instance.enabled ? this.liveNodesFor(instance, now) : null
      if (nodes) {
        ports.inlet.connect(nodes.input)
        nodes.output.connect(ports.outlet)
      } else {
        ports.inlet.connect(ports.outlet)
      }
    }
    for (const route of routes) {
      const from = route.from === 'in' ? chain.input : this.graphPorts.get(route.from)?.outlet
      const to = route.to === 'out' ? chain.auto : this.graphPorts.get(route.to)?.inlet
      if (from && to) from.connect(to)
    }
  }

  /** The live builtin nodes for an instance, created/applied on demand (null = not local). */
  private liveNodesFor(instance: PluginInstance, now: number): PluginNodes | null {
    let nodes = this.fxNodes.get(instance.id)
    if (!nodes) {
      const resolved = pluginRegistry.resolve(instance.descriptor)
      if (!resolved) return null
      nodes = resolved.provider.create(this.ctx!)
      this.fxNodes.set(instance.id, nodes)
    }
    nodes.apply(instance.params, now)
    return nodes
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

  /**
   * Click a recording count-in of `bars` whole bars starting now, while
   * the transport is still stopped. Returns the count-in's length in
   * seconds — the moment the roll (and capture) should begin.
   */
  countInClicks(bars: number): number {
    const ctx = this.ensureContext()
    const state = this.store.state
    const beatsPerBar = state.timeSignature[0]
    const secPerBeat = ticksPerBeat(state.timeSignature) / ticksPerSecond(state.tempo)
    // Small offset so the first click isn't clipped by scheduling latency.
    const start = ctx.currentTime + 0.06
    const total = bars * beatsPerBar
    for (let i = 0; i < total; i++) {
      this.scheduleClick(start + i * secPerBeat, i % beatsPerBar === 0)
    }
    return start + total * secPerBeat - ctx.currentTime
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
    const ctx = this.ctx
    if (!ctx) return
    const position = this.transport.positionTicks()
    this.nextBeatIndex = beatIndexAt(this.store.state, position)
    // The metronome keeps its own anchor because cycling moves the playhead
    // backwards, which the clip anchor deliberately does not follow. Both
    // halves of that anchor must be sampled at the SAME instant: pairing
    // the wrapped position with the clip anchor's linear tick/second pair
    // offsets every click by however far the loop had already wrapped
    // (silent at play, wrong when the metronome is switched on mid-cycle).
    this.metroAnchorTicks = position
    this.metroAnchorSec = ctx.currentTime
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
