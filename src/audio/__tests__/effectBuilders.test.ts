import { describe, expect, test } from 'vitest'
import { effectDefaults } from '@core/model/effects'
import { builtinEffectDescriptor } from '@core/plugins/builtin'
import type {
  BackendLatencies,
  BackendNodeId,
  IAudioBackend,
  InputHandle,
  InputOpenConfig,
  NodeKind,
  NodeOptions,
  ParamName,
  PlaySpec,
  StreamInfo,
  TapId,
  VoiceId
} from '../backend'
import { proImpulseBufferId } from '../impulse'
import { pluginRegistry } from '../pluginRegistry'

/**
 * The new builtins ride the exact provider path the live engine AND the
 * offline render share (both call registry.resolve(...).provider.create),
 * so building them against a bare seam-only backend is the cheap smoke of
 * both: wiring works, the IR registers deterministically on apply, and the
 * Web-Audio-only saturator honestly declines a backend without the escape
 * (the engine then bypasses it like a missing plugin).
 */

const SR = 48000

/** Seam-only backend: records the calls, has no webAudio escape. */
class RecordingBackend implements IAudioBackend {
  readonly webAudio = null
  readonly externalPlugins = null
  readonly created: Array<{ id: BackendNodeId; kind: NodeKind; opts?: NodeOptions }> = []
  readonly configured: Array<{ id: BackendNodeId; opts: NodeOptions }> = []
  readonly buffers = new Map<string, { channels: number; frames: number }>()
  registrations = 0
  private nextId = 1

  start(): StreamInfo {
    return { sampleRate: SR, outputChannels: 2 }
  }
  running(): boolean {
    return true
  }
  now(): number {
    return 0
  }
  latencies(): BackendLatencies {
    return { outputSec: 0, inputSec: null }
  }
  async setOutputDevice(): Promise<boolean> {
    return true
  }
  async enumerateDevices(): Promise<never[]> {
    return []
  }
  onDeviceChange(): () => void {
    return () => {}
  }
  createNode(kind: NodeKind, opts?: NodeOptions): BackendNodeId {
    const id = this.nextId++
    this.created.push({ id, kind, opts })
    return id
  }
  configureNode(id: BackendNodeId, opts: NodeOptions): void {
    this.configured.push({ id, opts })
  }
  connect(): void {}
  connectParam(): void {}
  disconnectParam(): void {}
  disconnect(): void {}
  disposeNode(): void {}
  masterNode(): BackendNodeId {
    return 0
  }
  outputNode(): BackendNodeId {
    return 0
  }
  scheduleParam(_node: BackendNodeId, _param: ParamName, _events: readonly unknown[]): void {}
  registerBuffer(id: string, channels: readonly Float32Array[]): void {
    this.registrations++
    this.buffers.set(id, { channels: channels.length, frames: channels[0]?.length ?? 0 })
  }
  hasBuffer(id: string): boolean {
    return this.buffers.has(id)
  }
  releaseBuffer(id: string): void {
    this.buffers.delete(id)
  }
  play(_spec: PlaySpec): VoiceId | null {
    return this.nextId++
  }
  scheduleSource(): VoiceId {
    return this.nextId++
  }
  stopVoice(): void {}
  onVoiceEnded(): () => void {
    return () => {}
  }
  createTap(): TapId {
    return this.nextId++
  }
  readTap(): boolean {
    return false
  }
  disposeTap(): void {}
  async openInput(_config: InputOpenConfig): Promise<InputHandle> {
    throw new Error('this backend fixture never opens a live input')
  }
}

describe('new builtin providers', () => {
  test('both register in the app-wide registry and resolve exactly', () => {
    for (const type of ['reverbpro', 'saturator'] as const) {
      const resolved = pluginRegistry.resolve(builtinEffectDescriptor(type))
      expect(resolved).not.toBeNull()
      expect(resolved!.quality).toBe('exact')
      expect(resolved!.provider.descriptor.uid).toBe(`superdaw.${type}`)
    }
  })

  test('reverbpro builds seam-only, registers its IR on apply, and reports no latency', () => {
    const backend = new RecordingBackend()
    const provider = pluginRegistry.resolve(builtinEffectDescriptor('reverbpro'))!.provider
    const nodes = provider.create(backend)
    expect(nodes).not.toBeNull()
    // Builtins deliberately report ZERO plugin-delay latency.
    expect(nodes!.latencySamples).toBeUndefined()

    const defaults = effectDefaults('reverbpro')
    nodes!.apply(defaults, 0)
    const expectedId = proImpulseBufferId(
      {
        decaySeconds: defaults.decay,
        damping: defaults.damping,
        size: defaults.size,
        width: defaults.width
      },
      SR
    )
    expect(backend.buffers.has(expectedId)).toBe(true)
    expect(backend.buffers.get(expectedId)).toEqual({
      channels: 2,
      frames: Math.round(SR * defaults.decay)
    })
    expect(backend.configured.some((c) => c.opts.buffer === expectedId)).toBe(true)

    // Re-applying unchanged params must NOT regenerate the impulse; a
    // shaping change must.
    expect(backend.registrations).toBe(1)
    nodes!.apply(defaults, 1)
    expect(backend.registrations).toBe(1)
    nodes!.apply({ ...defaults, damping: 0.9 }, 2)
    expect(backend.registrations).toBe(2)
    nodes!.dispose()
  })

  test('saturator declines a backend without the webAudio escape (clean bypass)', () => {
    const backend = new RecordingBackend()
    const provider = pluginRegistry.resolve(builtinEffectDescriptor('saturator'))!.provider
    expect(provider.create(backend)).toBeNull()
  })
})
