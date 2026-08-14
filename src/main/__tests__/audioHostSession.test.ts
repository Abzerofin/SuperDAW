import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { MessageChannel } from 'node:worker_threads'
import { describe, expect, test } from 'vitest'
import { NativeAudioBackend } from '../../audio/nativeBackend'
import type { PortLike } from '../../audio/hostProtocol'
import { createAudioHostSession, type AudiohostAddon } from '../audioHostSession'

/**
 * The renderer→utilityProcess→addon path, end to end minus Electron and
 * minus the device: the REAL NativeAudioBackend proxy drives the REAL
 * session over a REAL MessageChannel into the REAL native engine, and
 * renderOffline stands where the WASAPI callback runs the identical
 * block loop. Skipped where the addon isn't built (CI without MSVC).
 */

const addonPath = join(process.cwd(), 'native/audiohost/build/Release/audiohost.node')
const hasAddon = existsSync(addonPath)

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
