import { expect, suite, test } from 'vitest'
import type { Clip, ProjectState, Track } from '@core/model/types'
import { createEmptyProject } from '@core/model/types'
import { PPQ } from '@core/model/timebase'
import { AssetStore, type AudioBufferLike } from '../assets'
import {
  applyParamEvents,
  type BackendLatencies,
  type BackendNodeId,
  type IAudioBackend,
  type NodeKind,
  type ParamEvent,
  type PlaySpec,
  type StreamInfo,
  type TapId,
  type VoiceId
} from '../backend'
import { AudioEngine } from '../engine'

/**
 * Backend command-stream coverage (NATIVE_AUDIO_BACKEND §8 phase 0):
 * drive the REAL engine headless against a recording MockBackend and pin
 * the calls it makes — graph construction, voice scheduling math, fade
 * and automation event lists, teardown. The browser parity harness
 * (parity.ts) proves the audio; these prove the protocol, which is what
 * the native backend will implement.
 */

type Op =
  | { op: 'createNode'; kind: NodeKind; id: BackendNodeId }
  | { op: 'connect'; from: BackendNodeId; to: BackendNodeId }
  | { op: 'disconnect'; from: BackendNodeId; to?: BackendNodeId }
  | { op: 'disposeNode'; id: BackendNodeId }
  | { op: 'scheduleParam'; node: BackendNodeId; param: string; events: ParamEvent[] }
  | { op: 'registerBuffer'; id: string; frames: number; sampleRate: number }
  | { op: 'releaseBuffer'; id: string }
  | { op: 'play'; spec: PlaySpec; voice: VoiceId }
  | { op: 'stopVoice'; voice: VoiceId; atTime?: number }

class MockBackend implements IAudioBackend {
  readonly ops: Op[] = []
  readonly webAudio = null
  private nextId = 1
  private buffers = new Set<string>()
  timeSec = 0

  start(): StreamInfo {
    return { sampleRate: 48000, outputChannels: 2 }
  }
  running(): boolean {
    return true
  }
  now(): number {
    return this.timeSec
  }
  latencies(): BackendLatencies {
    return { outputSec: 0, inputSec: null }
  }
  async setOutputDevice(): Promise<boolean> {
    return true
  }
  createNode(kind: NodeKind): BackendNodeId {
    const id = this.nextId++
    this.ops.push({ op: 'createNode', kind, id })
    return id
  }
  configureNode(): void {}
  connectParam(): void {}
  disconnectParam(): void {}
  scheduleSource(): VoiceId {
    return this.nextId++
  }
  connect(from: BackendNodeId, to: BackendNodeId): void {
    this.ops.push({ op: 'connect', from, to })
  }
  disconnect(from: BackendNodeId, to?: BackendNodeId): void {
    this.ops.push({ op: 'disconnect', from, to })
  }
  disposeNode(id: BackendNodeId): void {
    this.ops.push({ op: 'disposeNode', id })
  }
  masterNode(): BackendNodeId {
    return 0
  }
  scheduleParam(node: BackendNodeId, param: 'gain' | 'pan', events: readonly ParamEvent[]): void {
    this.ops.push({ op: 'scheduleParam', node, param, events: [...events] })
  }
  registerBuffer(id: string, channels: readonly Float32Array[], sampleRate: number): void {
    this.buffers.add(id)
    this.ops.push({ op: 'registerBuffer', id, frames: channels[0]?.length ?? 0, sampleRate })
  }
  hasBuffer(id: string): boolean {
    return this.buffers.has(id)
  }
  releaseBuffer(id: string): void {
    this.buffers.delete(id)
    this.ops.push({ op: 'releaseBuffer', id })
  }
  play(spec: PlaySpec): VoiceId | null {
    if (!this.buffers.has(spec.bufferId)) return null
    const voice = this.nextId++
    this.ops.push({ op: 'play', spec, voice })
    return voice
  }
  stopVoice(voice: VoiceId, atTime?: number): void {
    this.ops.push({ op: 'stopVoice', voice, atTime })
  }
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

/** Enough of an AudioBuffer for the store and the engine's channel reads. */
function fakeBuffer(seconds: number, sampleRate = 48000): AudioBuffer {
  const length = Math.round(seconds * sampleRate)
  const data = new Float32Array(length)
  for (let i = 0; i < length; i++) data[i] = Math.sin((2 * Math.PI * 220 * i) / sampleRate) * 0.5
  const like: AudioBufferLike & { duration: number } = {
    numberOfChannels: 1,
    length,
    sampleRate,
    duration: seconds,
    getChannelData: () => data
  }
  return like as unknown as AudioBuffer
}

interface Rig {
  backend: MockBackend
  engine: AudioEngine
  fire: (event: 'play' | 'stop' | 'seek') => void
  transport: { isPlaying: boolean }
}

function buildRig(mutate?: (state: ProjectState) => ProjectState): Rig {
  const assets = new AssetStore()
  assets.restore('ast-1', 'tone', 'audio', 'wav', new Uint8Array(4), fakeBuffer(1))

  const track: Track = {
    id: 'trk-1',
    kind: 'audio',
    name: 'One',
    color: '#888',
    muted: false,
    soloed: false,
    volume: 0.8,
    pan: -0.25,
    synth: {},
    parentId: null,
    frozenAssetId: null
  }
  // Starts half a beat in (0.25 s at 120 bpm), trimmed into the material,
  // faded both ends, resampled — every number the play() call must carry.
  const clip: Clip = {
    id: 'clp-1',
    trackId: 'trk-1',
    name: 'clip',
    start: PPQ / 2,
    duration: PPQ,
    assetId: 'ast-1',
    offset: PPQ / 4,
    color: null,
    fadeIn: PPQ / 8,
    fadeOut: PPQ / 8,
    reverse: false,
    pitch: 0,
    stretch: 1,
    loopLength: 0
  }
  let state: ProjectState = {
    ...createEmptyProject('Rig'),
    tracks: { [track.id]: track },
    trackOrder: [track.id],
    clips: { [clip.id]: clip },
    automation: {
      'aut-1': { id: 'aut-1', trackId: 'trk-1', param: 'volume', ticks: 0, value: 1 },
      'aut-2': { id: 'aut-2', trackId: 'trk-1', param: 'volume', ticks: 2 * PPQ, value: 0.5 }
    }
  }
  if (mutate) state = mutate(state)

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
  const backend = new MockBackend()
  const engine = new AudioEngine({ state, subscribe: () => () => {} }, transport, assets)
  engine.setBackendFactory(() => backend)
  return {
    backend,
    engine,
    transport,
    fire: (event) => listeners.forEach((listener) => listener(event))
  }
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 20))

suite('engine → backend command stream', () => {
  test('play builds the chain and schedules the clip with exact numbers', async () => {
    const rig = buildRig()
    rig.fire('play')
    await settle()

    // The chain: three gains + a panner, wired input→auto→fader→panner→master.
    const created = rig.backend.ops.filter((o) => o.op === 'createNode')
    expect(created.map((o) => o.kind)).toEqual(['gain', 'gain', 'gain', 'stereoPanner', 'gain'])
    const [input, auto, fader, panner, fade] = created.map((o) => o.id)
    const connects = rig.backend.ops.filter((o) => o.op === 'connect')
    expect(connects).toEqual(
      expect.arrayContaining([
        { op: 'connect', from: input, to: auto },
        { op: 'connect', from: auto, to: fader },
        { op: 'connect', from: fader, to: panner },
        { op: 'connect', from: panner, to: 0 },
        // No inserts: the chain shorts input → auto after wiring.
        { op: 'connect', from: input, to: auto },
        // The fade envelope feeds the chain input.
        { op: 'connect', from: fade, to: input }
      ])
    )

    // The clip voice: start 0.25 s out, offset 0.125 s into the buffer,
    // half a second long, unresampled, into the fade gain.
    const plays = rig.backend.ops.filter((o) => o.op === 'play')
    expect(plays).toHaveLength(1)
    expect(plays[0].spec).toMatchObject({
      bufferId: 'ast-1',
      when: 0.25,
      offsetSec: 0.125,
      durationSec: 0.5,
      rate: 1,
      destination: fade
    })

    // The fade envelope: an anchor value + one raised-cosine curve per ramp.
    const fadeEvents = rig.backend.ops.filter(
      (o) => o.op === 'scheduleParam' && o.node === fade
    )
    expect(fadeEvents).toHaveLength(1)
    const kinds = (fadeEvents[0] as Extract<Op, { op: 'scheduleParam' }>).events.map(
      (e) => e.kind
    )
    expect(kinds[0]).toBe('setValue')
    expect(kinds.filter((k) => k === 'setCurve')).toHaveLength(2)

    // Volume automation on the auto gain: cancel+neutral from reset, then
    // the armed curve — setValue at the anchor, one ramp per later point.
    const autoEvents = rig.backend.ops
      .filter((o): o is Extract<Op, { op: 'scheduleParam' }> => o.op === 'scheduleParam')
      .filter((o) => o.node === auto)
      .flatMap((o) => o.events)
    expect(autoEvents).toEqual(
      expect.arrayContaining([
        { kind: 'cancel', afterTime: 0 },
        { kind: 'setValue', value: 1, time: 0 },
        { kind: 'linearRamp', value: 0.5, endTime: 1 }
      ])
    )
  })

  test('stop tears down every voice and fade node', async () => {
    const rig = buildRig()
    rig.fire('play')
    await settle()
    const played = rig.backend.ops.filter((o) => o.op === 'play')
    expect(played.length).toBeGreaterThan(0)
    rig.fire('stop')
    const stopped = rig.backend.ops.filter((o) => o.op === 'stopVoice' && o.atTime === undefined)
    expect(stopped.map((o) => (o as Extract<Op, { op: 'stopVoice' }>).voice)).toEqual(
      expect.arrayContaining(played.map((o) => (o as Extract<Op, { op: 'play' }>).voice))
    )
    const fadeId = rig.backend.ops.filter((o) => o.op === 'createNode')[4].id
    expect(rig.backend.ops).toEqual(
      expect.arrayContaining([{ op: 'disposeNode', id: fadeId }])
    )
  })

  test('a reversed clip registers the mirrored buffer under its own key', async () => {
    const rig = buildRig((state) => ({
      ...state,
      clips: {
        'clp-1': { ...state.clips['clp-1'], reverse: true, fadeIn: 0, fadeOut: 0 }
      }
    }))
    rig.fire('play')
    await settle()
    const registered = rig.backend.ops.filter((o) => o.op === 'registerBuffer').map((o) => o.id)
    expect(registered).toContain('ast-1!r')
    const plays = rig.backend.ops.filter((o) => o.op === 'play')
    expect(plays.some((o) => (o as Extract<Op, { op: 'play' }>).spec.bufferId === 'ast-1!r')).toBe(
      true
    )
  })

  test('a muted track still schedules; mute is gain-level, not schedule-level', async () => {
    const rig = buildRig((state) => ({
      ...state,
      tracks: { 'trk-1': { ...state.tracks['trk-1'], muted: true } }
    }))
    rig.fire('play')
    await settle()
    // The voice is queued — audibility rides the fader at zero gain.
    expect(rig.backend.ops.filter((o) => o.op === 'play')).toHaveLength(1)
    const created = rig.backend.ops.filter((o) => o.op === 'createNode')
    const fader = created[2].id
    const faderValues = rig.backend.ops
      .filter((o): o is Extract<Op, { op: 'scheduleParam' }> => o.op === 'scheduleParam')
      .filter((o) => o.node === fader)
      .flatMap((o) => o.events)
    expect(faderValues[0]).toMatchObject({ kind: 'setValue', value: 0 })
  })

  test('eviction pruning releases adopted buffers, reversed mirrors included', async () => {
    const rig = buildRig()
    rig.fire('play')
    await settle()
    rig.engine.pruneAdoptedBuffers(new Set(['ast-1']), new Set())
    const released = rig.backend.ops.filter((o) => o.op === 'releaseBuffer').map((o) => o.id)
    expect(released).toEqual(expect.arrayContaining(['ast-1', 'ast-1!r']))
  })
})

suite('applyParamEvents', () => {
  function fakeParam(failCurves = false): {
    param: AudioParam
    calls: Array<[string, ...unknown[]]>
  } {
    const calls: Array<[string, ...unknown[]]> = []
    const param = {
      setValueAtTime: (v: number, t: number) => calls.push(['setValue', v, t]),
      linearRampToValueAtTime: (v: number, t: number) => calls.push(['linearRamp', v, t]),
      setTargetAtTime: (v: number, t: number, c: number) => calls.push(['setTarget', v, t, c]),
      setValueCurveAtTime: (curve: Float32Array, t: number, d: number) => {
        if (failCurves) throw new Error('abutting event')
        calls.push(['setCurve', curve.length, t, d])
      },
      cancelScheduledValues: (t: number) => calls.push(['cancel', t])
    } as unknown as AudioParam
    return { param, calls }
  }

  test('translates each event kind onto the matching AudioParam call', () => {
    const { param, calls } = fakeParam()
    applyParamEvents(param, [
      { kind: 'cancel', afterTime: 1 },
      { kind: 'setValue', value: 0.5, time: 2 },
      { kind: 'linearRamp', value: 1, endTime: 3 },
      { kind: 'setTarget', value: 0, time: 4, timeConstant: 0.015 },
      { kind: 'setCurve', curve: new Float32Array([0, 1]), time: 5, duration: 0.5 }
    ])
    expect(calls).toEqual([
      ['cancel', 1],
      ['setValue', 0.5, 2],
      ['linearRamp', 1, 3],
      ['setTarget', 0, 4, 0.015],
      ['setCurve', 2, 5, 0.5]
    ])
  })

  test('a rejected curve falls back to a linear ramp to the curve end', () => {
    const { param, calls } = fakeParam(true)
    applyParamEvents(param, [
      { kind: 'setCurve', curve: new Float32Array([0, 0.4, 0.9]), time: 2, duration: 0.5 }
    ])
    // 0.9 read back through the Float32Array is the nearest float32.
    expect(calls).toEqual([['linearRamp', Math.fround(0.9), 2.5]])
  })
})
