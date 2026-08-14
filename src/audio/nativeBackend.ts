/**
 * NativeAudioBackend — IAudioBackend over a MessagePort to the audio
 * utilityProcess (docs/NATIVE_AUDIO_BACKEND.md §5, phase 2 stage 3).
 *
 * The seam's calls translate 1:1 into one-way HostCommand messages: ids
 * are minted HERE, so nothing round-trips inside the scheduling path.
 * The upstream direction is the periodic frame, which carries everything
 * the renderer polls — the stream clock (extrapolated between frames via
 * performance.now(), re-based on every arrival so drift is bounded by
 * port transit jitter), tap snapshots (readTap serves the latest one),
 * ended voice ids, and health counters.
 *
 * `webAudio` is null — the escapes documented on the seam simply switch
 * off. Phase 2's DSP ports closed the effect/instrument ones and phase 3
 * closed input (openInput below, over the duplex stream); what remains
 * off is the UI-facing AnalyserNode surface, so the plugin spectrum and
 * wire-scope panes go dark under this backend.
 *
 * Construction contract: the wiring layer (renderer/state/nativeAudio)
 * sends 'start' and waits for 'started' BEFORE handing this backend to
 * the engine, which is what lets start() answer synchronously with real
 * stream facts, exactly like the Web Audio implementation.
 */

import type {
  BackendLatencies,
  BackendNodeId,
  DeviceInfo,
  ExternalPluginSpec,
  InputHandle,
  InputOpenConfig,
  NodeKind,
  NodeOptions,
  ParamEvent,
  ParamName,
  PlaySpec,
  StreamInfo,
  TapId,
  VoiceId
} from './backendTypes'
import type { HostCommand, HostEvent, HostStreamInfo, PortLike } from './hostProtocol'

/** How long to wait for the host's `inputOpened` before giving up. Opening
 *  may reopen the device in duplex mode, so it is not instant — but a host
 *  that never answers must fail the gesture, not hang it forever. */
const OPEN_INPUT_TIMEOUT_MS = 5000

/**
 * Satisfies IAudioBackend STRUCTURALLY rather than by an `implements`
 * clause: naming the interface would drag backend.ts's Web Audio types
 * into DOM-free programs (the audio utilityProcess tests), and the
 * assignability is checked anyway where the renderer hands this to
 * `audioEngine.setBackendFactory`.
 */
export class NativeAudioBackend {
  readonly webAudio = null

  /** 0 is the output and 1 the master fader, both pre-created by the
   *  native engine — caller-minted ids start after them. */
  private nextId = 2
  private info: HostStreamInfo | null = null
  private latencySec = 0
  private inputLatencySec: number | null = null
  private xrunCount = 0

  /** Clock base: stream time at `baseWallMs`, re-based per frame. */
  private baseStream = 0
  private baseWallMs = 0

  private buffers = new Set<string>()
  private tapFrames = new Map<TapId, number>()
  private tapSnapshots = new Map<TapId, Float32Array>()
  private endedListeners = new Set<(id: VoiceId) => void>()
  private deviceListeners = new Set<() => void>()
  private devices: DeviceInfo[] = []
  /** Pending openInput round-trips, by node id. */
  private inputOpens = new Map<
    BackendNodeId,
    (result: { ok: boolean; channelCount: number; message?: string }) => void
  >()
  private captureListeners = new Map<
    BackendNodeId,
    (chunk: Float32Array[], firstFrameTime: number) => void
  >()
  /** Pending capture flushes, by node id (see the seam's unsubscribe). */
  private captureFlushes = new Map<BackendNodeId, () => void>()

  /** node → reported latency in samples; absent until the host answers. */
  private externalLatency = new Map<BackendNodeId, number>()
  private latencyListeners = new Set<() => void>()

  /**
   * External-format plugins run in the audio process, one lock-free slot
   * from the callback (docs/NATIVE_AUDIO_BACKEND.md §5). Everything here
   * is one-way; the only answer is `externalReady`, which the engine uses
   * to recompute plugin-delay compensation.
   */
  readonly externalPlugins = {
    create: (spec: ExternalPluginSpec): BackendNodeId => {
      const id = this.nextId++
      // Open first, then create: the host binds the node to whatever slot
      // the plugin got (or to none, which bypasses).
      this.send({
        t: 'openExternal',
        id,
        uid: spec.uid,
        stateBlob: spec.stateBlob ?? null,
        channels: spec.channels
      })
      this.send({ t: 'createNode', id, kind: 'external' as NodeKind })
      return id
    },
    setParams: (node: BackendNodeId, params: Readonly<Record<string, number>>): void => {
      this.send({ t: 'setPluginParams', node, params: { ...params } })
    },
    latencySamples: (node: BackendNodeId): number | null =>
      this.externalLatency.get(node) ?? null,
    onLatencyChange: (listener: () => void): (() => void) => {
      this.latencyListeners.add(listener)
      return () => this.latencyListeners.delete(listener)
    }
  }

  constructor(private port: PortLike) {
    port.onMessage((data) => this.onEvent(data as HostEvent))
    port.start?.()
  }

  /** The wiring layer records 'started' facts through this. */
  adoptStreamInfo(info: HostStreamInfo, latencySec: number): void {
    this.info = info
    this.latencySec = latencySec
  }

  get xruns(): number {
    return this.xrunCount
  }

  private send(command: HostCommand): void {
    this.port.postMessage(command)
  }

  private onEvent(event: HostEvent): void {
    if (event.t === 'devices') {
      this.devices = event.devices
      for (const listener of this.deviceListeners) listener()
      return
    }
    if (event.t === 'inputOpened') {
      const settle = this.inputOpens.get(event.node)
      this.inputOpens.delete(event.node)
      settle?.(event)
      return
    }
    if (event.t === 'capture') {
      for (const chunk of event.chunks) {
        this.captureListeners.get(chunk.node)?.(chunk.channels, chunk.startSec)
      }
      return
    }
    if (event.t === 'inputFlushed') {
      // The host posted its final batch before this, and the port keeps
      // order — so by now the listener has seen everything.
      const settle = this.captureFlushes.get(event.node)
      this.captureFlushes.delete(event.node)
      settle?.()
      return
    }
    if (event.t === 'externalReady') {
      // A plugin that failed to open reports no latency BECAUSE it is
      // bypassing — it delays nothing, so 0 is the truthful figure and
      // compensation stays out of the way.
      this.externalLatency.set(event.node, event.ok ? event.latencySamples : 0)
      if (!event.ok && event.message) {
        console.warn(`external insert bypassed: ${event.message}`)
      }
      for (const listener of this.latencyListeners) listener()
      return
    }
    if (event.t === 'frame') {
      this.baseStream = event.now
      this.baseWallMs = performance.now()
      this.latencySec = event.latencySec
      this.inputLatencySec = event.inputLatencySec > 0 ? event.inputLatencySec : null
      this.xrunCount = event.xruns
      for (const [tapId, data] of Object.entries(event.taps)) {
        this.tapSnapshots.set(Number(tapId), data)
      }
      for (const id of event.ended) {
        for (const listener of this.endedListeners) listener(id)
      }
    }
  }

  start(): StreamInfo {
    if (!this.info) throw new Error('NativeAudioBackend used before the stream started')
    return { sampleRate: this.info.sampleRate, outputChannels: this.info.outputChannels }
  }

  running(): boolean {
    return this.info !== null
  }

  now(): number {
    if (this.baseWallMs === 0) return this.baseStream
    return this.baseStream + (performance.now() - this.baseWallMs) / 1000
  }

  latencies(): BackendLatencies {
    // inputSec stays null until the stream is actually duplex — the
    // capture buffer depth is meaningless while there is no capture side.
    return { outputSec: this.latencySec, inputSec: this.inputLatencySec }
  }

  async setOutputDevice(deviceId: string | null): Promise<boolean> {
    // WASAPI cannot re-point a live stream, so the host reopens on the
    // new device; the graph and its buffers live in the engine, not the
    // stream, so playback machinery survives the swap.
    this.send({ t: 'setOutputDevice', deviceId })
    return true
  }

  async enumerateDevices(): Promise<DeviceInfo[]> {
    // Served from the pushed cache — no RPC in the UI's path. A refresh
    // is requested alongside, so the next call sees any change.
    this.send({ t: 'refreshDevices' })
    return this.devices
  }

  onDeviceChange(listener: () => void): () => void {
    this.deviceListeners.add(listener)
    return () => this.deviceListeners.delete(listener)
  }

  createNode(kind: NodeKind, opts?: NodeOptions): BackendNodeId {
    const id = this.nextId++
    this.send({ t: 'createNode', id, kind, opts })
    return id
  }

  configureNode(id: BackendNodeId, opts: NodeOptions): void {
    this.send({ t: 'configureNode', id, opts })
  }

  connect(from: BackendNodeId, to: BackendNodeId): void {
    this.send({ t: 'connect', from, to })
  }

  connectParam(from: BackendNodeId, to: BackendNodeId, param: ParamName): void {
    this.send({ t: 'connectParam', from, to, param })
  }

  disconnectParam(from: BackendNodeId, to: BackendNodeId, param: ParamName): void {
    this.send({ t: 'disconnectParam', from, to, param })
  }

  disconnect(from: BackendNodeId, to?: BackendNodeId): void {
    this.send({ t: 'disconnect', from, to })
  }

  disposeNode(id: BackendNodeId): void {
    this.externalLatency.delete(id)
    this.send({ t: 'disposeNode', id })
  }

  masterNode(): BackendNodeId {
    return 1
  }

  outputNode(): BackendNodeId {
    return 0
  }

  scheduleParam(node: BackendNodeId, param: ParamName, events: readonly ParamEvent[]): void {
    this.send({ t: 'scheduleParam', node, param, events: [...events] })
  }

  registerBuffer(id: string, channels: readonly Float32Array[], sampleRate: number): void {
    // Structured clone copies the channel data — the native process needs
    // its own PCM anyway (§5's table: once per asset, off the hot path).
    this.buffers.add(id)
    this.send({ t: 'registerBuffer', id, sampleRate, channels: [...channels] })
  }

  hasBuffer(id: string): boolean {
    return this.buffers.has(id)
  }

  releaseBuffer(id: string): void {
    if (!this.buffers.delete(id)) return
    this.send({ t: 'releaseBuffer', id })
  }

  play(spec: PlaySpec): VoiceId | null {
    // The unknown-buffer null is answered from local bookkeeping — the
    // registry lives on both sides, so no round-trip is needed.
    if (!this.buffers.has(spec.bufferId)) return null
    const id = this.nextId++
    this.send({
      t: 'play',
      id,
      bufferId: spec.bufferId,
      when: spec.when,
      offsetSec: spec.offsetSec,
      durationSec: spec.durationSec,
      rate: spec.rate,
      loop: spec.loop,
      destination: spec.destination
    })
    return id
  }

  scheduleSource(node: BackendNodeId, when: number, stopAt?: number): VoiceId {
    const id = this.nextId++
    this.send({ t: 'scheduleSource', id, node, when, stopAt })
    return id
  }

  stopVoice(id: VoiceId, atTime?: number): void {
    this.send({ t: 'stopVoice', id, atTime })
  }

  onVoiceEnded(listener: (id: VoiceId) => void): () => void {
    this.endedListeners.add(listener)
    return () => this.endedListeners.delete(listener)
  }

  createTap(node: BackendNodeId, frames: number): TapId {
    const id = this.nextId++
    this.tapFrames.set(id, frames)
    this.send({ t: 'createTap', id, node, frames })
    return id
  }

  readTap(id: TapId, out: Float32Array): boolean {
    const snapshot = this.tapSnapshots.get(id)
    if (!snapshot) return false
    const n = Math.min(out.length, snapshot.length)
    out.set(snapshot.subarray(snapshot.length - n))
    return true
  }

  disposeTap(id: TapId): void {
    this.tapFrames.delete(id)
    this.tapSnapshots.delete(id)
    this.send({ t: 'disposeTap', id })
  }

  async openInput(config: InputOpenConfig): Promise<InputHandle> {
    const node = this.nextId++
    const opened = new Promise<{ ok: boolean; channelCount: number; message?: string }>(
      (resolve) => {
        this.inputOpens.set(node, resolve)
        setTimeout(() => {
          if (!this.inputOpens.delete(node)) return
          resolve({ ok: false, channelCount: 0, message: 'the audio process did not answer' })
        }, OPEN_INPUT_TIMEOUT_MS)
      }
    )
    this.send({
      t: 'openInput',
      node,
      mode: config.mode,
      channel: config.channel,
      deviceId: config.deviceId ?? null
    })
    const result = await opened
    if (!result.ok) {
      this.send({ t: 'closeInput', node })
      throw new Error(result.message ?? 'no audio input is available')
    }
    return {
      node,
      channelCount: result.channelCount,
      sampleRate: this.info?.sampleRate ?? 0,
      capture: (listener) => {
        this.captureListeners.set(node, listener)
        this.send({ t: 'setInputCapture', node, enabled: true })
        return async () => {
          if (!this.captureListeners.has(node)) return
          const flushed = new Promise<void>((resolve) => {
            this.captureFlushes.set(node, resolve)
            // A host that stops answering must not hang a Stop button.
            setTimeout(() => {
              if (this.captureFlushes.delete(node)) resolve()
            }, OPEN_INPUT_TIMEOUT_MS)
          })
          this.send({ t: 'setInputCapture', node, enabled: false })
          await flushed
          this.captureListeners.delete(node)
        }
      },
      dispose: () => {
        this.captureListeners.delete(node)
        this.captureFlushes.get(node)?.()
        this.captureFlushes.delete(node)
        this.send({ t: 'closeInput', node })
      }
    }
  }
}
