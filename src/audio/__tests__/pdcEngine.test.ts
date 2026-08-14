import { expect, suite, test, vi } from 'vitest'
import type { PluginInstance, ProjectState, Track } from '@core/model/types'
import { createEmptyProject } from '@core/model/types'
import type { PluginDescriptor } from '@core/plugins/descriptor'
import { AssetStore } from '../assets'
import type {
  BackendLatencies,
  BackendNodeId,
  ExternalPluginSpec,
  IAudioBackend,
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
} from '../backend'
import { AudioEngine } from '../engine'
import type { ExternalPluginHost } from '../render'

/**
 * The engine half of live external inserts: given a backend that CAN host
 * them, does the engine place them as ordinary chain members and does its
 * plugin-delay compensation land on the right compensators with the right
 * values?
 *
 * The pure arithmetic is pinned separately (pdc.test.ts) and the native
 * half — the C bridge, the realtime slots, the host protocol — in
 * src/main/__tests__ against the real addons. What is only visible here is
 * the join: which node the engine writes each delay to, and that a latency
 * arriving LATE (a plugin has to load before it can be asked) still gets
 * compensated.
 */

const SR = 48000

const VST3: PluginDescriptor = {
  format: 'vst3',
  uid: 'uid-latent',
  name: 'Latent',
  vendor: 'Test',
  version: '1.0.0'
}

type Op =
  | { op: 'createNode'; kind: NodeKind; id: BackendNodeId; opts?: NodeOptions }
  | { op: 'connect'; from: BackendNodeId; to: BackendNodeId }
  | { op: 'scheduleParam'; node: BackendNodeId; param: string; events: ParamEvent[] }

/**
 * A backend that hosts external plugins, with the answer under the test's
 * control: `reportLatency` stands where the audio process's
 * `externalReady` arrives, so "the plugin has not answered yet" and "it
 * answered 1024" are both reachable states.
 */
class HostingBackend implements IAudioBackend {
  readonly ops: Op[] = []
  readonly webAudio = null
  private nextId = 1
  private latency = new Map<BackendNodeId, number>()
  private latencyListeners = new Set<() => void>()
  /** Every external node created, in order. */
  readonly externals: BackendNodeId[] = []

  readonly externalPlugins = {
    create: (spec: ExternalPluginSpec): BackendNodeId => {
      const id = this.nextId++
      this.ops.push({ op: 'createNode', kind: 'external', id, opts: { uid: spec.uid } })
      this.externals.push(id)
      return id
    },
    setParams: (): void => {},
    latencySamples: (node: BackendNodeId): number | null => this.latency.get(node) ?? null,
    onLatencyChange: (listener: () => void): (() => void) => {
      this.latencyListeners.add(listener)
      return () => this.latencyListeners.delete(listener)
    }
  }

  /** What the audio process reporting a plugin's latency does to the proxy. */
  reportLatency(node: BackendNodeId, samples: number): void {
    this.latency.set(node, samples)
    for (const listener of this.latencyListeners) listener()
  }

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
    return { outputSec: 0.01, inputSec: null }
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
    this.ops.push({ op: 'createNode', kind, id, opts })
    return id
  }
  configureNode(): void {}
  connect(from: BackendNodeId, to: BackendNodeId): void {
    this.ops.push({ op: 'connect', from, to })
  }
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
  async openInput(_config: InputOpenConfig): Promise<InputHandle> {
    throw new Error('this backend fixture never opens a live input')
  }
  scheduleParam(node: BackendNodeId, param: ParamName, events: readonly ParamEvent[]): void {
    this.ops.push({ op: 'scheduleParam', node, param, events: [...events] })
  }
  registerBuffer(): void {}
  hasBuffer(): boolean {
    return true
  }
  releaseBuffer(): void {}
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
}

function trackOf(id: string, parentId: string | null = null): Track {
  return {
    id,
    kind: 'audio',
    name: id,
    color: '#888',
    muted: false,
    soloed: false,
    volume: 1,
    pan: 0,
    synth: {},
    parentId,
    frozenAssetId: null
  }
}

function insertOf(id: string, trackId: string): PluginInstance {
  return { id, trackId, descriptor: VST3, enabled: true, rank: 1, params: {}, stateBlob: null }
}

function projectWith(tracks: Track[], plugins: PluginInstance[]): ProjectState {
  return {
    ...createEmptyProject('PDC'),
    tracks: Object.fromEntries(tracks.map((track) => [track.id, track])),
    trackOrder: tracks.map((track) => track.id),
    plugins: Object.fromEntries(plugins.map((plugin) => [plugin.id, plugin]))
  }
}

const hostWith = (...uids: string[]): ExternalPluginHost => ({
  has: (descriptor) => uids.includes(descriptor.uid),
  process: async () => null
})

function buildRig(state: ProjectState) {
  const backend = new HostingBackend()
  const listeners: Array<(event: 'play' | 'stop' | 'seek') => void> = []
  const transport = {
    isPlaying: true,
    positionTicks: () => 0,
    onEvent(listener: (event: 'play' | 'stop' | 'seek') => void) {
      listeners.push(listener)
      return () => {}
    },
    setTimeSource() {},
    setOutputLatency() {},
    activeLoop: () => null
  }
  const engine = new AudioEngine({ state, subscribe: () => () => {} }, transport, new AssetStore())
  engine.setBackendFactory(() => backend)
  return {
    backend,
    engine,
    play: (host: ExternalPluginHost) => {
      engine.setExternalHost(host)
      for (const listener of listeners) listener('play')
    }
  }
}

/**
 * A track's six chain nodes, in the order chain() creates them:
 * pdc(source), gain(input), gain(auto), gain(fader), stereoPanner, pdc(out).
 * Tracks are built in `trackOrder`, so the nth block is the nth track.
 */
function chainOf(backend: HostingBackend, index: number) {
  const pdcs = backend.ops.filter(
    (o): o is Extract<Op, { op: 'createNode' }> => o.op === 'createNode' && o.kind === 'pdc'
  )
  return { source: pdcs[index * 2].id, out: pdcs[index * 2 + 1].id }
}

/**
 * The delay a compensator currently holds, in samples. Nothing written =
 * zero: the engine only writes what CHANGED, and both backends default a
 * fresh compensator to no delay.
 */
function delaySamplesOf(backend: HostingBackend, node: BackendNodeId): number {
  const events = backend.ops
    .filter((o): o is Extract<Op, { op: 'scheduleParam' }> => o.op === 'scheduleParam')
    .filter((o) => o.node === node && o.param === 'delayTime')
    .flatMap((o) => o.events)
  const last = events[events.length - 1]
  if (!last) return 0
  return last.kind === 'setValue' ? Math.round(last.value * SR) : NaN
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 20))

suite('engine placement of live external inserts', () => {
  test('an external insert is wired into the chain like any other', async () => {
    const rig = buildRig(projectWith([trackOf('t1')], [insertOf('ins-1', 't1')]))
    rig.play(hostWith(VST3.uid))
    await settle()

    expect(rig.backend.externals).toHaveLength(1)
    const external = rig.backend.externals[0]
    const chain = chainOf(rig.backend, 0)
    // Source compensator → chain input → the plugin → the automation gain.
    const connects = rig.backend.ops.filter((o) => o.op === 'connect')
    const into = connects.find((o) => o.to === external)
    const outOf = connects.find((o) => o.from === external)
    expect(into).toBeDefined()
    expect(outOf).toBeDefined()
    expect(into!.from).not.toBe(chain.source) // the insert head, not the compensator
  })

  test('a plugin the backend cannot host is never even created', async () => {
    const rig = buildRig(projectWith([trackOf('t1')], [insertOf('ins-1', 't1')]))
    // The host does not have it: bypassed, exactly like a missing plugin.
    rig.play(hostWith())
    await settle()
    expect(rig.backend.externals).toHaveLength(0)
    expect(rig.engine.pdcLatencySec()).toBe(0)
  })

  test('latency arriving late still moves the compensators', async () => {
    const rig = buildRig(
      projectWith([trackOf('latent'), trackOf('plain')], [insertOf('ins-1', 'latent')])
    )
    rig.play(hostWith(VST3.uid))
    await settle()

    const latent = chainOf(rig.backend, 0)
    const plain = chainOf(rig.backend, 1)
    // A plugin has to LOAD before it can report anything, so until it
    // answers everything is uncompensated — and audibly fine, because an
    // unopened plugin is bypassing and delays nothing either.
    expect(rig.engine.pdcLatencySec()).toBe(0)
    expect(delaySamplesOf(rig.backend, plain.out)).toBe(0)

    rig.backend.reportLatency(rig.backend.externals[0], 1024)
    await settle()

    // The latent track waits for nobody; everything else waits for it.
    expect(delaySamplesOf(rig.backend, latent.out)).toBe(0)
    expect(delaySamplesOf(rig.backend, latent.source)).toBe(0)
    expect(delaySamplesOf(rig.backend, plain.out)).toBe(1024)
    expect(rig.engine.pdcLatencySec()).toBeCloseTo(1024 / SR, 6)
  })

  test("a folder's own material waits for its latent child; the child does not", async () => {
    const rig = buildRig(
      projectWith(
        [trackOf('folder'), trackOf('child', 'folder'), trackOf('outside')],
        [insertOf('ins-1', 'child')]
      )
    )
    rig.play(hostWith(VST3.uid))
    await settle()
    rig.backend.reportLatency(rig.backend.externals[0], 512)
    await settle()

    const folder = chainOf(rig.backend, 0)
    const child = chainOf(rig.backend, 1)
    const outside = chainOf(rig.backend, 2)
    // The folder's OWN clips wait for the child at its input; the child
    // arrives at that same input and must not be delayed twice.
    expect(delaySamplesOf(rig.backend, folder.source)).toBe(512)
    expect(delaySamplesOf(rig.backend, folder.out)).toBe(0)
    expect(delaySamplesOf(rig.backend, child.out)).toBe(0)
    // Outside the folder, the whole latent path has to be waited out.
    expect(delaySamplesOf(rig.backend, outside.out)).toBe(512)
    expect(rig.engine.pdcLatencySec()).toBeCloseTo(512 / SR, 6)
  })

  test('the compensation shows up in the latency the playhead corrects by', async () => {
    const rig = buildRig(
      projectWith([trackOf('latent'), trackOf('plain')], [insertOf('ins-1', 'latent')])
    )
    rig.play(hostWith(VST3.uid))
    await settle()
    const before = rig.engine.outputLatencySec()
    rig.backend.reportLatency(rig.backend.externals[0], 2048)
    await vi.waitFor(() =>
      expect(rig.engine.outputLatencySec()).toBeCloseTo(before + 2048 / SR, 6)
    )
  })

  test('removing the plugin gives the compensation back', async () => {
    const state = projectWith(
      [trackOf('latent'), trackOf('plain')],
      [insertOf('ins-1', 'latent')]
    )
    const rig = buildRig(state)
    rig.play(hostWith(VST3.uid))
    await settle()
    rig.backend.reportLatency(rig.backend.externals[0], 1024)
    await settle()
    expect(rig.engine.pdcLatencySec()).toBeCloseTo(1024 / SR, 6)

    // The engine reads the store live, so dropping the insert and asking
    // for a rewire is what an undo or a delete does.
    delete (state.plugins as Record<string, PluginInstance>)['ins-1']
    rig.play(hostWith(VST3.uid))
    await settle()
    expect(rig.engine.pdcLatencySec()).toBe(0)
    expect(delaySamplesOf(rig.backend, chainOf(rig.backend, 1).out)).toBe(0)
  })
})
