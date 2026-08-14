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
 * off: builtin inserts bypass, instrument voices and monitoring stay
 * silent, analysis panes go dark. That is the honest experimental v1
 * surface; the phase-2 DSP ports close it.
 *
 * Construction contract: the wiring layer (renderer/state/nativeAudio)
 * sends 'start' and waits for 'started' BEFORE handing this backend to
 * the engine, which is what lets start() answer synchronously with real
 * stream facts, exactly like the Web Audio implementation.
 */

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
import type { HostCommand, HostEvent, HostStreamInfo, PortLike } from './hostProtocol'

/**
 * Satisfies IAudioBackend STRUCTURALLY rather than by an `implements`
 * clause: naming the interface would drag backend.ts's Web Audio types
 * into DOM-free programs (the audio utilityProcess tests), and the
 * assignability is checked anyway where the renderer hands this to
 * `audioEngine.setBackendFactory`.
 */
export class NativeAudioBackend {
  readonly webAudio = null

  private nextId = 1
  private info: HostStreamInfo | null = null
  private latencySec = 0
  private xrunCount = 0

  /** Clock base: stream time at `baseWallMs`, re-based per frame. */
  private baseStream = 0
  private baseWallMs = 0

  private buffers = new Set<string>()
  private tapFrames = new Map<TapId, number>()
  private tapSnapshots = new Map<TapId, Float32Array>()
  private endedListeners = new Set<(id: VoiceId) => void>()

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
    if (event.t === 'frame') {
      this.baseStream = event.now
      this.baseWallMs = performance.now()
      this.latencySec = event.latencySec
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
    return { outputSec: this.latencySec, inputSec: null }
  }

  async setOutputDevice(deviceId: string | null): Promise<boolean> {
    // Per-backend device selection is the §6 unification, still ahead of
    // this stage — the native stream opens on the system default.
    return deviceId === null
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

  disconnect(from: BackendNodeId, to?: BackendNodeId): void {
    this.send({ t: 'disconnect', from, to })
  }

  disposeNode(id: BackendNodeId): void {
    this.send({ t: 'disposeNode', id })
  }

  masterNode(): BackendNodeId {
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
      destination: spec.destination
    })
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
}
