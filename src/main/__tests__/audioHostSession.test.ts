import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { MessageChannel } from 'node:worker_threads'
import { describe, expect, test } from 'vitest'
import { NativeAudioBackend } from '../../audio/nativeBackend'
import type { HostEvent, PortLike } from '../../audio/hostProtocol'
import {
  createAudioHostSession,
  type AudiohostAddon,
  type Vst3RealtimeAddon
} from '../audioHostSession'

/**
 * The renderer→utilityProcess→addon path, end to end minus Electron and
 * minus the device: the REAL NativeAudioBackend proxy drives the REAL
 * session over a REAL MessageChannel into the REAL native engine, and
 * renderOffline stands where the WASAPI callback runs the identical
 * block loop. Skipped where the addon isn't built (CI without MSVC).
 */

const addonPath = join(process.cwd(), 'native/audiohost/build/Release/audiohost.node')
const vst3Path = join(process.cwd(), 'native/vst3host/build/Release/vst3host.node')
const hasAddon = existsSync(addonPath)
const hasVst3 = hasAddon && existsSync(vst3Path)

function wirePort(port: import('node:worker_threads').MessagePort): PortLike {
  return {
    postMessage: (message) => port.postMessage(message),
    onMessage: (listener) => port.on('message', listener),
    start: () => port.start()
  }
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 25))

describe.skipIf(!hasAddon)('audio host session ↔ NativeAudioBackend', () => {
  test('commands cross the channel and the native engine renders them', async () => {
    const require = createRequire(import.meta.url)
    const addon = require(addonPath) as AudiohostAddon
    const { port1, port2 } = new MessageChannel()
    const session = createAudioHostSession(addon, wirePort(port2), { manualFrames: true })
    const backend = new NativeAudioBackend(wirePort(port1))
    backend.adoptStreamInfo(
      { sampleRate: 48000, outputChannels: 2, periodFrames: 128, periodCount: 3, exclusive: false },
      0.01
    )
    expect(backend.start().sampleRate).toBe(48000)

    // A chain: gain 0.5 into the master, a tone voice starting at 50 ms.
    const tone = new Float32Array(24000)
    for (let i = 0; i < tone.length; i++) tone[i] = 0.8 * Math.sin((2 * Math.PI * 440 * i) / 48000)
    const node = backend.createNode('gain')
    backend.scheduleParam(node, 'gain', [{ kind: 'setValue', value: 0.5, time: 0 }])
    backend.connect(node, backend.masterNode())
    backend.registerBuffer('tone', [tone], 48000)
    expect(backend.hasBuffer('tone')).toBe(true)
    const tap = backend.createTap(node, 256)
    const voice = backend.play({ bufferId: 'tone', when: 0.05, destination: node })
    expect(voice).not.toBeNull()
    // Unknown buffers answer null locally, no round-trip.
    expect(backend.play({ bufferId: 'nope', when: 0, destination: node })).toBeNull()

    const ended: number[] = []
    backend.onVoiceEnded((id) => ended.push(id))

    await settle() // let the port deliver before rendering

    const rms = (data: Float32Array, fromSec: number, toSec: number): number => {
      const from = Math.round(fromSec * 48000)
      const to = Math.round(toSec * 48000)
      let sum = 0
      for (let i = from; i < to; i++) sum += data[i * 2] * data[i * 2]
      return Math.sqrt(sum / (to - from))
    }

    // First 300 ms: silent before the 50 ms start, half-gain tone after
    // (0.8·0.5/√2 ≈ 0.283). The tap's ring holds the LATEST window, so
    // read it here, while the voice is still sounding.
    const head = addon.renderOffline(0, Math.round(0.3 * 48000), 48000) as unknown as Float32Array
    expect(rms(head, 0, 0.045)).toBeLessThan(1e-6)
    expect(rms(head, 0.1, 0.3)).toBeCloseTo(0.283, 2)
    session.pumpFrame()
    await settle()
    expect(ended).not.toContain(voice)
    const window = new Float32Array(256)
    expect(backend.readTap(tap, window)).toBe(true)
    let peak = 0
    for (const v of window) peak = Math.max(peak, Math.abs(v))
    expect(peak).toBeGreaterThan(0.2)

    // The rest: the voice runs out at 0.55 s and the frame reports it.
    const tail = addon.renderOffline(0.3, Math.round(0.7 * 48000), 48000) as unknown as Float32Array
    expect(rms(tail, 0.3, 0.4)).toBeLessThan(1e-3) // 0.6..0.7 s absolute: past the end
    session.pumpFrame()
    await settle()
    expect(ended).toContain(voice)

    session.dispose()
    port1.close()
    port2.close()
  })
})

/**
 * External inserts across the same wire: the renderer asks for a plugin by
 * descriptor uid, the session resolves it against the index MAIN pushed,
 * binds the node to a realtime slot, and answers with the latency that
 * plugin-delay compensation needs.
 *
 * The BRIDGE is the real one out of vst3host — that is the part whose ABI
 * has to line up, and the audiohost engine refuses a table it does not
 * recognise. The plugin lifecycle around it is stubbed, so this runs on
 * any machine with the addons built, with or without a VST3 installed.
 */
describe.skipIf(!hasVst3)('external plugin inserts over the host protocol', () => {
  interface Opened {
    path: string
    uid: string
    options: { sampleRate: number; blockSize?: number; channels?: number; state?: Buffer }
  }

  function rig(options: { paths?: Record<string, string>; latency?: number } = {}) {
    const require = createRequire(import.meta.url)
    const addon = require(addonPath) as AudiohostAddon
    const realBridge = (require(vst3Path) as { realtimeBridge(): unknown }).realtimeBridge()

    const opens: Opened[] = []
    const params: Array<{ slot: number; params: Record<string, number> }> = []
    const closed: number[] = []
    let nextSlot = 0
    const vst3: Vst3RealtimeAddon = {
      realtimeBridge: () => realBridge,
      openRealtime: (path, uid, opts) => {
        opens.push({ path, uid, options: opts })
        return {
          slot: nextSlot++,
          latencySamples: options.latency ?? 0,
          inputChannels: 2,
          outputChannels: 2
        }
      },
      setRealtimeParams: (slot, next) => params.push({ slot, params: next }),
      closeRealtime: (slot) => {
        closed.push(slot)
        return { closed: true }
      }
    }

    const { port1, port2 } = new MessageChannel()
    const events: HostEvent[] = []
    port1.on('message', (data) => events.push(data as HostEvent))
    port1.start()
    const session = createAudioHostSession(addon, wirePort(port2), {
      manualFrames: true,
      vst3,
      pluginPaths: options.paths ?? { 'uid-sat': 'C:/Plugins/Sat.vst3' }
    })
    const backend = new NativeAudioBackend({
      postMessage: (message) => port1.postMessage(message),
      onMessage: () => {},
      start: () => {}
    })
    const done = (): void => {
      session.dispose()
      port1.close()
      port2.close()
    }
    return { addon, backend, session, events, opens, params, closed, done }
  }

  const ready = (events: HostEvent[]): Extract<HostEvent, { t: 'externalReady' }>[] =>
    events.filter((e): e is Extract<HostEvent, { t: 'externalReady' }> => e.t === 'externalReady')

  test('an installed plugin opens, binds a slot and reports its latency', async () => {
    const r = rig({ latency: 1024 })
    const node = r.backend.externalPlugins.create({ uid: 'uid-sat', stateBlob: null })
    r.backend.externalPlugins.setParams(node, { '3': 0.75 })
    await settle()

    // The path came from MAIN's index, never from the renderer.
    expect(r.opens).toHaveLength(1)
    expect(r.opens[0]).toMatchObject({ path: 'C:/Plugins/Sat.vst3', uid: 'uid-sat' })
    // Whole engine blocks in one call: the plugin is set up for exactly that.
    expect(r.opens[0].options.blockSize).toBe(128)
    expect(ready(r.events)).toEqual([
      { t: 'externalReady', node, ok: true, latencySamples: 1024, message: undefined }
    ])
    expect(r.params).toEqual([{ slot: 0, params: { '3': 0.75 } }])
    r.done()
  })

  test('a plugin this machine does not have bypasses, and says why', async () => {
    const r = rig({ paths: {} })
    const node = r.backend.externalPlugins.create({ uid: 'uid-ghost', stateBlob: null })
    await settle()
    expect(r.opens).toHaveLength(0)
    const answered = ready(r.events)
    expect(answered).toHaveLength(1)
    expect(answered[0]).toMatchObject({ node, ok: false, latencySamples: 0 })
    expect(answered[0].message).toContain('uid-ghost')
    // The node still exists and passes audio: an insert that cannot run is
    // bypassed, never a hole in the chain.
    r.addon.connect(node, 0)
    const out = r.addon.renderOffline(20_000, 256, 48000)
    expect(Number.isFinite(out[0])).toBe(true)
    r.done()
  })

  test("the document's stateBlob is restored into the plugin at open", async () => {
    const r = rig()
    const blob = JSON.stringify({ component: Buffer.from('preset-bytes').toString('base64') })
    r.backend.externalPlugins.create({ uid: 'uid-sat', stateBlob: blob })
    await settle()
    expect(r.opens[0].options.state?.toString()).toBe('preset-bytes')
    r.done()
  })

  test('disposing an insert releases the plugin it held', async () => {
    const r = rig()
    const node = r.backend.externalPlugins.create({ uid: 'uid-sat', stateBlob: null })
    await settle()
    r.backend.disposeNode(node)
    await settle()
    expect(r.closed).toEqual([0])
    // And the renderer forgets its latency, so compensation stops paying
    // for a plugin that is gone.
    expect(r.backend.externalPlugins.latencySamples(node)).toBeNull()
    r.done()
  })

  test('a leaked insert is still released when the session goes away', async () => {
    const r = rig()
    r.backend.externalPlugins.create({ uid: 'uid-sat', stateBlob: null })
    await settle()
    r.session.dispose()
    expect(r.closed).toEqual([0])
    r.done()
  })

  test('the proxy reports latency to whoever is watching for it', async () => {
    const r = rig({ latency: 480 })
    // The renderer-side view: the engine subscribes to this and recomputes
    // compensation when a plugin finally answers.
    const seen: Array<number | null> = []
    const backendPort: PortLike = {
      postMessage: () => {},
      onMessage: () => {},
      start: () => {}
    }
    const proxy = new NativeAudioBackend(backendPort)
    const node = proxy.externalPlugins.create({ uid: 'uid-sat' })
    proxy.externalPlugins.onLatencyChange(() =>
      seen.push(proxy.externalPlugins.latencySamples(node))
    )
    expect(proxy.externalPlugins.latencySamples(node)).toBeNull()
    ;(proxy as unknown as { onEvent(event: HostEvent): void }).onEvent({
      t: 'externalReady',
      node,
      ok: true,
      latencySamples: 480
    })
    expect(seen).toEqual([480])
    r.done()
  })
})
