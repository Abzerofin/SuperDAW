/**
 * The audio backend seam (docs/NATIVE_AUDIO_BACKEND.md §3, phase 0).
 *
 * One interface, two implementations: `WebAudioBackend` (below — an
 * adapter over the AudioContext the engine used to drive directly) and,
 * later, the native addon's proxy (phase 2). Everything crossing the
 * interface is serializable — integer node/voice/tap ids, named buffers,
 * plain param-event lists — so the same calls work in-process today and
 * over a MessagePort against the native audio utilityProcess later.
 *
 * Phase-0 deviations from the doc's sketch, all deliberate:
 *
 * - `scheduleParam` APPENDS events in order, exactly like the AudioParam
 *   calls it replaces (cancel is an explicit event). Phase 0 must be
 *   behavior-preserving; a replace/merge queue would not be.
 * - No `stopVoicesTo`: the engine already indexes its voices per track
 *   (scoped teardown, pad-loop collect sets) and per-voice stops preserve
 *   that logic unchanged.
 * - `onVoiceEnded` exists (the doc's interface had no end signal, but the
 *   engine's bookkeeping is built on onended). Notification cadence is
 *   unspecified — the native backend may batch it with the meter tick.
 * - `NodeKind` is only what the engine itself instantiates today. The DSP
 *   primitives ('biquad', 'delay', …) arrive with the phase-2 ports.
 * - `webAudio` is the documented phase-0/1 escape hatch: non-null ONLY on
 *   this Web Audio implementation, used by the engine for exactly the
 *   pieces the doc schedules for later phases — builtin effect builders
 *   and instrument voices (phase 2 DSP ports), monitor input nodes
 *   (phase 3 duplex input), decode, and zero-copy adoption of already
 *   decoded AudioBuffers (a renderer-side memory concern the native
 *   backend replaces with its own PCM registry). Every use site is a
 *   grep-able `webAudio` reference — the phase-2/3 work list.
 */

// The serializable currency lives in backendTypes.ts (DOM-free, shared
// with the audio utilityProcess); re-exported so seam consumers keep one
// import site.
import type {
  BackendLatencies,
  BackendNodeId,
  NodeKind,
  NodeOptions,
  ParamEvent,
  ParamName,
  PlaySpec,
  StreamInfo,
  TapId,
  VoiceId
} from './backendTypes'

export type {
  BackendLatencies,
  BackendNodeId,
  NodeKind,
  NodeOptions,
  ParamEvent,
  ParamName,
  PlaySpec,
  StreamInfo,
  TapId,
  VoiceId
}

export interface IAudioBackend {
  /** Idempotent. Creates the stream/context; safe before a user gesture. */
  start(): StreamInfo
  running(): boolean

  // ---- clock + latency ----
  /** Stream time, seconds. Installs as the transport's TimeSource. */
  now(): number
  latencies(): BackendLatencies
  /** Route output to a device (null = system default). Live, no restart. */
  setOutputDevice(deviceId: string | null): Promise<boolean>

  // ---- graph ----
  createNode(kind: NodeKind, opts?: NodeOptions): BackendNodeId
  /** Instant non-param attributes (a biquad's type) — Web Audio semantics. */
  configureNode(id: BackendNodeId, opts: NodeOptions): void
  connect(from: BackendNodeId, to: BackendNodeId): void
  /**
   * Audio-rate modulation: `from`'s signal is downmixed to mono and ADDED
   * to `to`'s named param (an LFO driving a gain). Web Audio's
   * node→AudioParam connection.
   */
  connectParam(from: BackendNodeId, to: BackendNodeId, param: ParamName): void
  disconnectParam(from: BackendNodeId, to: BackendNodeId, param: ParamName): void
  /** No `to`: sever EVERY outgoing connection (Web Audio disconnect()). */
  disconnect(from: BackendNodeId, to?: BackendNodeId): void
  disposeNode(id: BackendNodeId): void
  /** The node every track chain ultimately feeds (master gain). */
  masterNode(): BackendNodeId
  /** Append param events in order — AudioParam semantics (see above);
   *  names resolve per node kind, unknown names are ignored. */
  scheduleParam(node: BackendNodeId, param: ParamName, events: readonly ParamEvent[]): void

  // ---- buffers + voices ----
  registerBuffer(id: string, channels: readonly Float32Array[], sampleRate: number): void
  hasBuffer(id: string): boolean
  releaseBuffer(id: string): void
  play(spec: PlaySpec): VoiceId | null
  /**
   * Schedule a GENERATED source node (an oscillator) as a voice: audible
   * from `when` until `stopAt`, then reported through onVoiceEnded like
   * any buffer voice. Omit `stopAt` for an open-ended note (a held key),
   * ended later by stopVoice. The caller owns the node and disposes its
   * graph when the voice ends.
   */
  scheduleSource(node: BackendNodeId, when: number, stopAt?: number): VoiceId
  /**
   * With `atTime`: schedule the stop and let the end notification clean
   * up (a pad's fade-out). Without: stop and disconnect immediately
   * (teardown), which still fires the end notification.
   */
  stopVoice(id: VoiceId, atTime?: number): void
  /** One engine-wide subscription; fires for every voice that ends. */
  onVoiceEnded(listener: (id: VoiceId) => void): () => void

  // ---- analysis taps ----
  /** Ring of the last `frames` samples of the signal at `node`. */
  createTap(node: BackendNodeId, frames: number): TapId
  /** Latest window into `out`; false = no data yet. */
  readTap(id: TapId, out: Float32Array): boolean
  disposeTap(id: TapId): void

  /** Phase-0 escape hatch — see module comment. Null on non-Web-Audio backends. */
  readonly webAudio: WebAudioEscapes | null
}

/** The Web-Audio-only surface (each use is phase-2/3 work — module comment). */
export interface WebAudioEscapes {
  readonly ctx: AudioContext
  nodeOf(id: BackendNodeId): AudioNode
  /** Zero-copy: register an ALREADY-DECODED AudioBuffer under an id. */
  adoptBuffer(id: string, buffer: AudioBuffer): void
  /** Wrap a foreign AudioNode (plugin port, monitor tap) as a backend node. */
  adoptNode(node: AudioNode): BackendNodeId
  /**
   * Track a Web-Audio-built scheduled source (instrument voice) as a
   * backend voice: stopVoice and the end notification apply to it like
   * any played buffer. The source's own onended cleanup is preserved.
   */
  adoptVoice(source: AudioScheduledSourceNode): VoiceId
}

/**
 * Apply a param-event list to a live AudioParam — the one translation
 * point between the serializable currency and Web Audio. Shared with
 * fades.ts so the offline render speaks the identical dialect.
 */
export function applyParamEvents(param: AudioParam, events: readonly ParamEvent[]): void {
  for (const event of events) {
    switch (event.kind) {
      case 'setValue':
        param.setValueAtTime(event.value, event.time)
        break
      case 'linearRamp':
        param.linearRampToValueAtTime(event.value, event.endTime)
        break
      case 'exponentialRamp':
        param.exponentialRampToValueAtTime(event.value, event.endTime)
        break
      case 'setTarget':
        param.setTargetAtTime(event.value, event.time, event.timeConstant)
        break
      case 'setCurve':
        try {
          param.setValueCurveAtTime(event.curve, event.time, event.duration)
        } catch {
          // Some engines reject a curve that abuts other events (the spec
          // allows an event exactly AT the curve start; implementations
          // have differed). A linear ramp to the curve's end value is an
          // acceptable stand-in — and infinitely better than letting the
          // exception abort the scheduling pass and silence the song.
          param.linearRampToValueAtTime(
            event.curve[event.curve.length - 1],
            event.time + event.duration
          )
        }
        break
      case 'cancel':
        param.cancelScheduledValues(event.afterTime)
        break
    }
  }
}

interface WebVoice {
  readonly source: AudioScheduledSourceNode
}

/**
 * The Web Audio implementation: today's engine graph behind the seam.
 * Owns the AudioContext (including the latency-hint request and the
 * test-only context factory the parity harness injects).
 */
export class WebAudioBackend implements IAudioBackend {
  private ctx: AudioContext | null = null
  private master: GainNode | null = null
  private masterId: BackendNodeId | null = null

  private nodes = new Map<BackendNodeId, AudioNode>()
  private buffers = new Map<string, AudioBuffer>()
  private voices = new Map<VoiceId, WebVoice>()
  private taps = new Map<TapId, AnalyserNode>()
  private endedListeners = new Set<(id: VoiceId) => void>()
  private nextId = 1

  readonly webAudio: WebAudioEscapes

  constructor(
    private options: {
      latencyHint?: () => AudioContextLatencyCategory | number
      /** Test seam: the parity harness injects a patched OfflineAudioContext. */
      contextFactory?: () => AudioContext
    } = {}
  ) {
    // Built here so the accessors close over a constructed `this`.
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this
    this.webAudio = {
      get ctx(): AudioContext {
        return self.ensureCtx()
      },
      nodeOf: (id) => self.node(id),
      adoptBuffer: (id, buffer) => {
        self.buffers.set(id, buffer)
      },
      adoptNode: (node) => {
        const id = self.nextId++
        self.nodes.set(id, node)
        return id
      },
      adoptVoice: (source) => {
        const id = self.nextId++
        const previous = source.onended
        source.onended = (event) => {
          if (previous) previous.call(source, event)
          self.voices.delete(id)
          for (const listener of self.endedListeners) listener(id)
        }
        self.voices.set(id, { source })
        return id
      }
    }
  }

  start(): StreamInfo {
    const ctx = this.ensureCtx()
    return { sampleRate: ctx.sampleRate, outputChannels: ctx.destination.maxChannelCount }
  }

  running(): boolean {
    return this.ctx !== null
  }

  private ensureCtx(): AudioContext {
    if (this.ctx) return this.ctx
    this.ctx = this.options.contextFactory
      ? this.options.contextFactory()
      : new AudioContext({ latencyHint: this.options.latencyHint?.() ?? 'interactive' })
    this.master = this.ctx.createGain()
    this.master.connect(this.ctx.destination)
    this.masterId = this.nextId++
    this.nodes.set(this.masterId, this.master)
    return this.ctx
  }

  now(): number {
    return this.ctx?.currentTime ?? 0
  }

  latencies(): BackendLatencies {
    const ctx = this.ctx as (AudioContext & { outputLatency?: number }) | null
    if (!ctx) return { outputSec: 0, inputSec: null }
    const base = typeof ctx.baseLatency === 'number' ? ctx.baseLatency : 0
    const out = typeof ctx.outputLatency === 'number' ? ctx.outputLatency : 0
    return { outputSec: base + out, inputSec: null }
  }

  async setOutputDevice(deviceId: string | null): Promise<boolean> {
    // setSinkId is Chromium-era; feature-detect so the plain-browser build
    // (and older engines) degrade to the default device silently.
    const ctx = this.ctx as (AudioContext & { setSinkId?(id: string): Promise<void> }) | null
    if (!ctx?.setSinkId) return deviceId === null
    try {
      await ctx.setSinkId(deviceId ?? '')
      return true
    } catch {
      return false
    }
  }

  createNode(kind: NodeKind, opts?: NodeOptions): BackendNodeId {
    const ctx = this.ensureCtx()
    const node =
      kind === 'gain'
        ? ctx.createGain()
        : kind === 'stereoPanner'
          ? ctx.createStereoPanner()
          : kind === 'delay'
            ? ctx.createDelay(typeof opts?.maxDelay === 'number' ? opts.maxDelay : 1)
            : kind === 'compressor'
              ? ctx.createDynamicsCompressor()
              : kind === 'convolver'
                ? ctx.createConvolver()
                : kind === 'oscillator'
                  ? ctx.createOscillator()
                  : ctx.createBiquadFilter()
    const id = this.nextId++
    this.nodes.set(id, node)
    if (opts) this.configureNode(id, opts)
    // Oscillators do NOT auto-start: scheduleSource is how any generated
    // source begins, so a synth note and a free-running LFO take the
    // same path on both backends.
    return id
  }

  configureNode(id: BackendNodeId, opts: NodeOptions): void {
    const node = this.node(id)
    if (node instanceof BiquadFilterNode && typeof opts.type === 'string') {
      node.type = opts.type as BiquadFilterType
    } else if (node instanceof OscillatorNode && typeof opts.type === 'string') {
      node.type = opts.type as OscillatorType
    } else if (node instanceof ConvolverNode && typeof opts.buffer === 'string') {
      // `normalize` stays at its default (true): the native backend
      // reproduces exactly that scaling, so both agree.
      const buffer = this.buffers.get(opts.buffer)
      if (buffer) node.buffer = buffer
    }
  }

  private node(id: BackendNodeId): AudioNode {
    const node = this.nodes.get(id)
    if (!node) throw new Error(`Unknown backend node ${id}`)
    return node
  }

  connect(from: BackendNodeId, to: BackendNodeId): void {
    this.node(from).connect(this.node(to))
  }

  /** The AudioParam a (node, name) pair addresses, for modulation edges. */
  private paramOf(id: BackendNodeId, param: ParamName): AudioParam | undefined {
    const node = this.node(id)
    if (node instanceof GainNode) return param === 'gain' ? node.gain : undefined
    if (node instanceof StereoPannerNode) return param === 'pan' ? node.pan : undefined
    if (node instanceof DelayNode) return param === 'delayTime' ? node.delayTime : undefined
    if (node instanceof OscillatorNode) {
      return param === 'frequency' ? node.frequency : param === 'detune' ? node.detune : undefined
    }
    if (node instanceof BiquadFilterNode) {
      if (param === 'frequency') return node.frequency
      if (param === 'Q') return node.Q
      if (param === 'gain') return node.gain
      if (param === 'detune') return node.detune
    }
    return undefined
  }

  connectParam(from: BackendNodeId, to: BackendNodeId, param: ParamName): void {
    const target = this.paramOf(to, param)
    if (target) this.node(from).connect(target)
  }

  disconnectParam(from: BackendNodeId, to: BackendNodeId, param: ParamName): void {
    const target = this.paramOf(to, param)
    if (!target) return
    try {
      this.node(from).disconnect(target)
    } catch {
      // already disconnected — fine
    }
  }

  disconnect(from: BackendNodeId, to?: BackendNodeId): void {
    try {
      if (to === undefined) this.node(from).disconnect()
      else this.node(from).disconnect(this.node(to))
    } catch {
      // already disconnected — matches the engine's historical tolerance
    }
  }

  disposeNode(id: BackendNodeId): void {
    const node = this.nodes.get(id)
    if (!node) return
    try {
      node.disconnect()
    } catch {
      // already disconnected
    }
    this.nodes.delete(id)
  }

  masterNode(): BackendNodeId {
    this.ensureCtx()
    return this.masterId!
  }

  scheduleParam(id: BackendNodeId, param: ParamName, events: readonly ParamEvent[]): void {
    const node = this.node(id)
    // Per-kind name resolution; unknown names are ignored (the reducer's
    // drop-don't-throw hygiene, so both backends shrug identically).
    let target: AudioParam | undefined
    if (node instanceof GainNode) {
      if (param === 'gain') target = node.gain
    } else if (node instanceof StereoPannerNode) {
      if (param === 'pan') target = node.pan
    } else if (node instanceof BiquadFilterNode) {
      if (param === 'frequency') target = node.frequency
      else if (param === 'Q') target = node.Q
      else if (param === 'gain') target = node.gain
      else if (param === 'detune') target = node.detune
    } else if (node instanceof DelayNode) {
      if (param === 'delayTime') target = node.delayTime
    } else if (node instanceof OscillatorNode) {
      if (param === 'frequency') target = node.frequency
      else if (param === 'detune') target = node.detune
    } else if (node instanceof DynamicsCompressorNode) {
      if (param === 'threshold') target = node.threshold
      else if (param === 'knee') target = node.knee
      else if (param === 'ratio') target = node.ratio
      else if (param === 'attack') target = node.attack
      else if (param === 'release') target = node.release
    }
    if (target) applyParamEvents(target, events)
  }

  registerBuffer(id: string, channels: readonly Float32Array[], sampleRate: number): void {
    const ctx = this.ensureCtx()
    const buffer = ctx.createBuffer(
      Math.max(1, channels.length),
      channels[0]?.length ?? 1,
      sampleRate
    )
    channels.forEach((data, ch) => buffer.copyToChannel(data as Float32Array<ArrayBuffer>, ch))
    this.buffers.set(id, buffer)
  }

  hasBuffer(id: string): boolean {
    return this.buffers.has(id)
  }

  releaseBuffer(id: string): void {
    this.buffers.delete(id)
  }

  play(spec: PlaySpec): VoiceId | null {
    const ctx = this.ensureCtx()
    const buffer = this.buffers.get(spec.bufferId)
    if (!buffer) return null
    const source = ctx.createBufferSource()
    source.buffer = buffer
    if (spec.rate !== undefined && spec.rate !== 1) source.playbackRate.value = spec.rate
    if (spec.loop) {
      source.loop = true
      source.loopStart = spec.loop.startSec
      source.loopEnd = spec.loop.endSec
    }
    source.connect(this.node(spec.destination))
    const id = this.nextId++
    source.onended = () => {
      this.voices.delete(id)
      for (const listener of this.endedListeners) listener(id)
    }
    if (spec.durationSec !== undefined) {
      source.start(spec.when, spec.offsetSec ?? 0, spec.durationSec)
    } else {
      source.start(spec.when, spec.offsetSec ?? 0)
    }
    this.voices.set(id, { source })
    return id
  }

  scheduleSource(node: BackendNodeId, when: number, stopAt?: number): VoiceId {
    const source = this.node(node) as AudioScheduledSourceNode
    source.start(when)
    if (stopAt !== undefined && Number.isFinite(stopAt)) source.stop(stopAt)
    return this.webAudio.adoptVoice(source)
  }

  stopVoice(id: VoiceId, atTime?: number): void {
    const voice = this.voices.get(id)
    if (!voice) return
    try {
      voice.source.stop(atTime)
    } catch {
      // never started or already stopped — fine
    }
    if (atTime === undefined) {
      // Immediate teardown; onended (kept attached — instrument voices
      // disconnect their internal nodes there) still fires and notifies.
      voice.source.disconnect()
      this.voices.delete(id)
    }
  }

  onVoiceEnded(listener: (id: VoiceId) => void): () => void {
    this.endedListeners.add(listener)
    return () => this.endedListeners.delete(listener)
  }

  createTap(node: BackendNodeId, frames: number): TapId {
    const ctx = this.ensureCtx()
    const analyser = ctx.createAnalyser()
    analyser.fftSize = frames
    this.node(node).connect(analyser)
    const id = this.nextId++
    this.taps.set(id, analyser)
    return id
  }

  readTap(id: TapId, out: Float32Array): boolean {
    const analyser = this.taps.get(id)
    if (!analyser) return false
    analyser.getFloatTimeDomainData(out as Float32Array<ArrayBuffer>)
    return true
  }

  disposeTap(id: TapId): void {
    const analyser = this.taps.get(id)
    if (!analyser) return
    try {
      analyser.disconnect()
    } catch {
      // already disconnected
    }
    this.taps.delete(id)
  }

}
