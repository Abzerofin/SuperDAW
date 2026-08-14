import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { MessageChannel } from 'node:worker_threads'
import { describe, expect, test } from 'vitest'
import { NativeAudioBackend } from '../../audio/nativeBackend'
import { Recorder } from '../../audio/recorder'
import type { PortLike } from '../../audio/hostProtocol'
import { createAudioHostSession, type AudiohostAddon } from '../audioHostSession'

/**
 * Native duplex input (docs/NATIVE_AUDIO_BACKEND.md §7, phase 3), in two
 * layers.
 *
 * The DSP layer drives the real addon: renderOffline takes the capture
 * material the duplex callback would have delivered, so the channel-select
 * tap and the capture rings are verified numerically — no microphone, no
 * device, no timing.
 *
 * The PROTOCOL layer drives the real NativeAudioBackend proxy and the real
 * session over a real MessageChannel against a scripted addon, because
 * opening an input is the one command that has to reopen the stream in
 * duplex mode — which needs hardware, and which the numbers above cannot
 * exercise.
 */

const addonPath = join(process.cwd(), 'native/audiohost/build/Release/audiohost.node')
const hasAddon = existsSync(addonPath)
const RATE = 48000

function wirePort(port: import('node:worker_threads').MessagePort): PortLike {
  return {
    postMessage: (message) => port.postMessage(message),
    onMessage: (listener) => port.on('message', listener),
    start: () => port.start()
  }
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 25))

/**
 * Interleaved capture material: channel `ch` carries a sine at
 * (ch + 1) × 100 Hz scaled by (ch + 1) / 10, so every channel is
 * distinguishable at every sample.
 */
function captureMaterial(frames: number, channels: number): Float32Array {
  const out = new Float32Array(frames * channels)
  for (let i = 0; i < frames; i++) {
    for (let ch = 0; ch < channels; ch++) {
      out[i * channels + ch] =
        ((ch + 1) / 10) * Math.sin((2 * Math.PI * (ch + 1) * 100 * i) / RATE)
    }
  }
  return out
}

function channelOf(material: Float32Array, frames: number, channels: number, ch: number): Float32Array {
  const out = new Float32Array(frames)
  for (let i = 0; i < frames; i++) out[i] = material[i * channels + ch]
  return out
}

describe.skipIf(!hasAddon)('native duplex input — DSP', () => {
  const require = createRequire(import.meta.url)
  const addon = require(addonPath) as AudiohostAddon
  addon.init()
  let id = 120_000

  /** Render `frames` from `t0` with the given capture material attached. */
  const render = (t0: number, frames: number, material: Float32Array, channels: number): Float32Array =>
    addon.renderOffline(t0, frames, RATE, material, channels) as unknown as Float32Array

  test('mono takes one channel to both sides; stereo takes the pair', () => {
    const frames = 512
    const channels = 4
    const material = captureMaterial(frames, channels)

    const mono = id++
    addon.createNode(mono, 'input', { mode: 'mono', channel: 2 })
    addon.connect(mono, 0)
    const monoOut = render(0, frames, material, channels)
    addon.disconnect(mono)
    addon.disposeNode(mono)

    const third = channelOf(material, frames, channels, 2)
    for (let i = 0; i < frames; i++) {
      // Both sides carry the SELECTED channel, untouched — audio/input.ts's
      // mono rule (centred, so panning still decides placement).
      expect(monoOut[i * 2]).toBeCloseTo(third[i], 6)
      expect(monoOut[i * 2 + 1]).toBeCloseTo(third[i], 6)
    }

    const stereo = id++
    addon.createNode(stereo, 'input', { mode: 'stereo', channel: 1 })
    addon.connect(stereo, 0)
    const stereoOut = render(0, frames, material, channels)
    addon.disconnect(stereo)
    addon.disposeNode(stereo)

    const second = channelOf(material, frames, channels, 1)
    for (let i = 0; i < frames; i++) {
      expect(stereoOut[i * 2]).toBeCloseTo(second[i], 6)
      expect(stereoOut[i * 2 + 1]).toBeCloseTo(third[i], 6)
    }
    // The two selections are genuinely different signals, so passing both
    // assertions above cannot be an artefact of the material.
    expect(Math.max(...second.map((v, i) => Math.abs(v - third[i])))).toBeGreaterThan(0.1)
  })

  test('a selection past the last channel clamps instead of reading past it', () => {
    const frames = 256
    const channels = 2
    const material = captureMaterial(frames, channels)
    const node = id++
    // Channel 7 on a 2-channel device: clamp to the last, and the stereo
    // partner clamps onto it too rather than running off the end.
    addon.createNode(node, 'input', { mode: 'stereo', channel: 7 })
    addon.connect(node, 0)
    const out = render(0, frames, material, channels)
    addon.disconnect(node)
    addon.disposeNode(node)

    const last = channelOf(material, frames, channels, 1)
    for (let i = 0; i < frames; i++) {
      expect(out[i * 2]).toBeCloseTo(last[i], 6)
      expect(out[i * 2 + 1]).toBeCloseTo(last[i], 6)
    }
  })

  test('a mono input is still a STEREO signal downstream (panner law parity)', () => {
    // The Web Audio tap's merger is a 2-channel node even in mono mode, so
    // StereoPanner reads its stereo law — hard left folds the right side
    // into the left and a mono-duplicated signal lands at 2×. Reading the
    // mono law here instead would make monitoring quieter than Web Audio.
    const frames = 256
    const channels = 2
    const material = captureMaterial(frames, channels)
    const node = id++
    const panner = id++
    addon.createNode(node, 'input', { mode: 'mono', channel: 0 })
    addon.createNode(panner, 'stereoPanner')
    addon.scheduleParam(panner, 'pan', [{ kind: 'setValue', value: -1, time: 0 }])
    addon.connect(node, panner)
    addon.connect(panner, 0)
    const out = render(0, frames, material, channels)
    addon.disconnect(node)
    addon.disconnect(panner)
    addon.disposeNode(node)
    addon.disposeNode(panner)

    const first = channelOf(material, frames, channels, 0)
    for (let i = 0; i < frames; i++) {
      expect(out[i * 2]).toBeCloseTo(2 * first[i], 5)
      expect(out[i * 2 + 1]).toBeCloseTo(0, 6)
    }
  })

  test('capture delivers the selected channels and the time of the first frame', () => {
    const frames = 640
    const channels = 4
    const material = captureMaterial(frames, channels)
    const node = id++
    const t0 = 3.5
    addon.createNode(node, 'input', { mode: 'stereo', channel: 0 })
    // NOT connected to anything: recording an unmonitored track is the
    // normal case, so capture must not depend on being reachable.
    addon.setInputCapture(node, true, RATE)
    const out = render(t0, frames, material, channels)

    let outputPeak = 0
    for (const v of out) outputPeak = Math.max(outputPeak, Math.abs(v))
    expect(outputPeak).toBe(0)

    const chunks = addon.drainCapture()
    expect(chunks).toHaveLength(1)
    expect(chunks[0].node).toBe(node)
    expect(chunks[0].startSec).toBeCloseTo(t0, 9)
    expect(chunks[0].channels[0]).toHaveLength(frames)

    const left = channelOf(material, frames, channels, 0)
    const right = channelOf(material, frames, channels, 1)
    for (let i = 0; i < frames; i++) {
      expect(chunks[0].channels[0][i]).toBeCloseTo(left[i], 6)
      expect(chunks[0].channels[1][i]).toBeCloseTo(right[i], 6)
    }

    // Drained dry: a second drain with nothing new reports nothing.
    expect(addon.drainCapture()).toHaveLength(0)
    addon.setInputCapture(node, false, 0)
    addon.disposeNode(node)
  })

  test('a reader that falls a whole ring behind loses the OLDEST frames, and says so', () => {
    const frames = 1024
    const channels = 2
    const material = captureMaterial(frames, channels)
    const node = id++
    const t0 = 10
    const capacity = 256
    addon.createNode(node, 'input', { mode: 'mono', channel: 0 })
    addon.setInputCapture(node, true, capacity)
    render(t0, frames, material, channels)

    const chunks = addon.drainCapture()
    expect(chunks).toHaveLength(1)
    expect(chunks[0].channels[0]).toHaveLength(capacity)
    // The surviving window is the END of the render, and its start time
    // jumps forward by exactly what was lost — which is what lets the
    // recorder pad a hole rather than splice the take short.
    expect(chunks[0].startSec).toBeCloseTo(t0 + (frames - capacity) / RATE, 9)
    const first = channelOf(material, frames, channels, 0)
    for (let i = 0; i < capacity; i++) {
      expect(chunks[0].channels[0][i]).toBeCloseTo(first[frames - capacity + i], 6)
    }

    addon.setInputCapture(node, false, 0)
    addon.disposeNode(node)
  })

  test('a stream with no capture side reports no input', () => {
    // Nothing here ever opens a device, so the addon must say so rather
    // than quoting the playback path's numbers back as input figures.
    // (The duplex reopen itself needs hardware: smoketest.js covers it,
    // including the clock staying monotonic across the reopen.)
    expect(addon.inputChannels()).toBe(0)
    expect(addon.inputLatencySec()).toBe(0)
  })
})

// --------------------------------------------------------------- protocol

/** A scripted addon: enough surface to drive the session, no hardware. */
function scriptedAddon(options: { captureChannels: number }): AudiohostAddon & {
  calls: string[]
  queue: Array<{ node: number; startSec: number; channels: Float32Array[] }>
} {
  let inputChannels = 0
  const calls: string[] = []
  const queue: Array<{ node: number; startSec: number; channels: Float32Array[] }> = []
  return {
    calls,
    queue,
    init: () => 'wasapi',
    start: (opts) => {
      inputChannels = opts.input ? options.captureChannels : 0
      calls.push(`start input=${opts.input === true} device=${opts.inputDeviceId ?? 'null'}`)
      return {
        sampleRate: RATE,
        outputChannels: 2,
        periodFrames: 128,
        periodCount: 3,
        exclusive: false,
        inputChannels
      }
    },
    stop: () => {
      inputChannels = 0
    },
    enumerateDevices: () => [],
    now: () => 0,
    latencySec: () => 0.008,
    inputLatencySec: () => (inputChannels > 0 ? 0.004 : 0),
    inputChannels: () => inputChannels,
    stats: () => ({ xruns: 0 }),
    createNode: (id, kind, opts) => calls.push(`createNode ${id} ${kind} ${JSON.stringify(opts)}`),
    configureNode: () => {},
    connect: () => {},
    connectParam: () => {},
    disconnectParam: () => {},
    disconnect: () => {},
    disposeNode: (id) => calls.push(`disposeNode ${id}`),
    scheduleParam: () => {},
    registerBuffer: () => {},
    releaseBuffer: () => {},
    play: () => true,
    scheduleSource: () => {},
    stopVoice: () => {},
    createTap: () => {},
    disposeTap: () => {},
    readTap: () => false,
    drainEnded: () => [],
    setInputCapture: (node, enabled, capacityFrames) =>
      calls.push(`setInputCapture ${node} ${enabled} ${capacityFrames}`),
    drainCapture: () => queue.splice(0, queue.length),
    renderOffline: () => new Float32Array(0)
  }
}

describe('native duplex input — protocol', () => {
  test('openInput upgrades the stream, capture batches reach a Recording', async () => {
    const addon = scriptedAddon({ captureChannels: 4 })
    const { port1, port2 } = new MessageChannel()
    const session = createAudioHostSession(addon, wirePort(port2), { manualFrames: true })
    const backend = new NativeAudioBackend(wirePort(port1))
    backend.adoptStreamInfo(
      {
        sampleRate: RATE,
        outputChannels: 2,
        periodFrames: 128,
        periodCount: 3,
        exclusive: false,
        inputChannels: 0
      },
      0.008
    )
    // The stream starts playback-only; opening an input is what brings the
    // capture side up (and the microphone indicator with it).
    port1.postMessage({ t: 'start', opts: {} })
    await settle()
    expect(addon.calls).toContain('start input=false device=null')

    const handle = await backend.openInput({ mode: 'stereo', channel: 2, deviceId: 'mic-1' })
    expect(handle.channelCount).toBe(4)
    expect(handle.sampleRate).toBe(RATE)
    expect(addon.calls).toContain('start input=true device=mic-1')
    expect(addon.calls).toContain(
      `createNode ${handle.node} input {"mode":"stereo","channel":2}`
    )

    const recorder = new Recorder()
    recorder.start(handle)
    await settle()
    // 4 s of ring at the granted rate (HOST_CAPTURE_RING_SECONDS).
    expect(addon.calls).toContain(`setInputCapture ${handle.node} true ${4 * RATE}`)

    const chunk = (start: number, frames: number, value: number): void => {
      addon.queue.push({
        node: handle.node,
        startSec: start,
        channels: [new Float32Array(frames).fill(value), new Float32Array(frames).fill(-value)]
      })
    }
    chunk(2, 4800, 0.25) // 100 ms from t = 2 s
    session.pumpCapture()
    await settle()
    // A 50 ms hole: the host fell behind and the next batch starts late.
    chunk(2.15, 4800, 0.5)
    session.pumpCapture()
    await settle()
    // The tail: captured but NOT yet batched over the wire when Stop is
    // pressed. Hanging up here would clip it off the take.
    chunk(2.25, 2400, 0.75)

    const take = await recorder.stop()
    expect(take).not.toBeNull()
    expect(take!.startSec).toBe(2)
    expect(take!.sampleRate).toBe(RATE)
    // 100 ms + 50 ms of padded silence + 100 ms + the rescued 50 ms tail.
    expect(take!.droppedFrames).toBe(2400)
    expect(take!.channels[0]).toHaveLength(4800 + 2400 + 4800 + 2400)
    expect(take!.seconds).toBeCloseTo(0.3, 6)
    expect(take!.channels[0][0]).toBeCloseTo(0.25, 6)
    expect(take!.channels[1][0]).toBeCloseTo(-0.25, 6)
    expect(take!.channels[0][4800 + 1200]).toBe(0) // inside the hole
    expect(take!.channels[0][4800 + 2400]).toBeCloseTo(0.5, 6)
    expect(take!.channels[0][4800 + 2400 + 4800]).toBeCloseTo(0.75, 6)

    handle.dispose()
    await settle()
    expect(addon.calls).toContain(`disposeNode ${handle.node}`)
    // Last input gone: the capture side is released rather than held open
    // for a session that may never record again.
    expect(addon.calls.filter((c) => c === 'start input=false device=null')).toHaveLength(2)

    session.dispose()
    port1.close()
    port2.close()
  })

  test('no capture device: openInput rejects and the stream stays playback-only', async () => {
    const addon = scriptedAddon({ captureChannels: 0 })
    const { port1, port2 } = new MessageChannel()
    const session = createAudioHostSession(addon, wirePort(port2), { manualFrames: true })
    const backend = new NativeAudioBackend(wirePort(port1))
    backend.adoptStreamInfo(
      {
        sampleRate: RATE,
        outputChannels: 2,
        periodFrames: 128,
        periodCount: 3,
        exclusive: false,
        inputChannels: 0
      },
      0.008
    )
    port1.postMessage({ t: 'start', opts: {} })
    await settle()

    await expect(backend.openInput({ mode: 'mono', channel: 0 })).rejects.toThrow(
      /no audio input device/
    )
    // Nothing was built, so nothing needs unwinding — the addon's own
    // duplex fallback already left the stream playing.
    expect(addon.calls.some((c) => c.startsWith('createNode'))).toBe(false)

    session.dispose()
    port1.close()
    port2.close()
  })
})
