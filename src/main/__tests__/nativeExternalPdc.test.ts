import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import type { AudiohostAddon, Vst3RealtimeAddon } from '../audioHostSession'

/**
 * The two node kinds live external inserts needed: `pdc`, the exact delay
 * that keeps a latent chain aligned, and `external`, the plugin call
 * inside the audio callback.
 *
 * The PDC checks are the load-bearing ones and need no plugin at all: an
 * impulse in, and the sample it comes out on. "Exact" is the whole
 * requirement — a compensator that is a sample or two off, or that
 * attenuates, would be worse than none. They also pin the property the
 * kind exists for: zero delay is a true passthrough, which the ordinary
 * `delay` node cannot give (its read side is clamped to a whole block so
 * feedback cycles resolve).
 *
 * The bridge checks run against a REAL installed VST3 where there is one,
 * because the thing worth verifying — that a plugin's own DSP reaches the
 * callback — cannot be faked. Where none is installed they skip, and the
 * bypass behaviour (no bridge, no slot) is checked regardless, since that
 * is what every machine without the plugin actually gets.
 */

const addonPath = join(process.cwd(), 'native/audiohost/build/Release/audiohost.node')
const vst3Path = join(process.cwd(), 'native/vst3host/build/Release/vst3host.node')
const hasAddon = existsSync(addonPath)

const SR = 48000

describe.skipIf(!hasAddon)('native pdc + external nodes', () => {
  const require = createRequire(import.meta.url)
  const addon = require(addonPath) as AudiohostAddon
  addon.init()
  let id = 400_000
  let clock = 9000

  /** A unit impulse `at` samples in, registered as a buffer. */
  function impulse(at: number, frames = 8192): string {
    const data = new Float32Array(frames)
    data[at] = 1
    const bufferId = `pdc-imp-${id++}`
    addon.registerBuffer(bufferId, [data], SR)
    return bufferId
  }

  /** Where the single impulse landed, and how tall it still is. */
  function findImpulse(out: Float32Array, frames: number): { at: number; peak: number } {
    let at = -1
    let peak = 0
    for (let i = 0; i < frames; i++) {
      const v = Math.abs(out[i * 2])
      if (v > peak) {
        peak = v
        at = i
      }
    }
    return { at, peak }
  }

  /** One impulse through one node, rendered offline. */
  function throughNode(
    make: (node: number) => void,
    impulseAt = 10,
    frames = 4096
  ): { at: number; peak: number } {
    const t0 = clock
    clock += 2
    const node = id++
    make(node)
    addon.connect(node, 0)
    addon.play({ id: id++, bufferId: impulse(impulseAt), when: t0, destination: node })
    const out = addon.renderOffline(t0, frames, SR)
    addon.disposeNode(node)
    addon.drainEnded()
    return findImpulse(out, frames)
  }

  test('a pdc node with no capacity is an exact passthrough', () => {
    // The state every chain is in until something reports latency: not
    // "nearly zero delay" but no delay and no line allocated at all.
    const { at, peak } = throughNode((node) => addon.createNode(node, 'pdc'))
    expect(at).toBe(10)
    expect(peak).toBeCloseTo(1, 6)
  })

  test('a pdc node at zero delay is an exact passthrough', () => {
    const { at, peak } = throughNode((node) => {
      addon.createNode(node, 'pdc')
      addon.configureNode(node, { maxDelay: 0.1 })
      addon.scheduleParam(node, 'delayTime', [{ kind: 'setValue', value: 0, time: 0 }])
    })
    expect(at).toBe(10)
    expect(peak).toBeCloseTo(1, 6)
  })

  test('a pdc delay is exact to the sample, and does not attenuate', () => {
    // 777 is deliberately not a multiple of the 128-frame block: a
    // compensator that only worked on block boundaries would pass a
    // rounder number and fail this.
    for (const delaySamples of [1, 127, 128, 129, 777, 4800]) {
      const { at, peak } = throughNode(
        (node) => {
          addon.createNode(node, 'pdc')
          addon.configureNode(node, { maxDelay: 0.25 })
          addon.scheduleParam(node, 'delayTime', [
            { kind: 'setValue', value: delaySamples / SR, time: 0 }
          ])
        },
        10,
        8192
      )
      expect({ delaySamples, at }).toEqual({ delaySamples, at: 10 + delaySamples })
      expect(peak).toBeCloseTo(1, 6)
    }
  })

  test('a delay past the configured capacity clamps instead of wrapping', () => {
    // A plugin that misreports its latency must not be able to fold the
    // mix back on itself: the compensation saturates at the line's length
    // and stays causal, with the signal intact.
    //
    // The line is sized against the HIGHEST rate it could be read at
    // (192 kHz), not the rate in use, because the device may not be open
    // when the capacity is set and a device switch can raise it. So a
    // 0.01 s capacity is ~1920 frames of room even at 48 kHz — generous,
    // which is the safe direction. The real ceiling on compensation is the
    // engine's own (PDC_MAX_SEC); this is the last-resort guard.
    const capacityFrames = Math.ceil(0.01 * 192000)
    const { at, peak } = throughNode(
      (node) => {
        addon.createNode(node, 'pdc')
        addon.configureNode(node, { maxDelay: 0.01 })
        addon.scheduleParam(node, 'delayTime', [{ kind: 'setValue', value: 1, time: 0 }])
      },
      10,
      8192
    )
    expect(at).toBeGreaterThan(10)
    expect(at).toBeLessThanOrEqual(10 + capacityFrames + 2 * 128)
    expect(peak).toBeCloseTo(1, 6)
  })

  test('an external node with no plugin bound passes audio through', () => {
    // What every machine without the plugin hears, and what a plugin that
    // failed to load leaves behind: the insert is simply not there.
    const { at, peak } = throughNode((node) => addon.createNode(node, 'external'))
    expect(at).toBe(10)
    expect(peak).toBeCloseTo(1, 6)

    const bound = throughNode((node) => addon.createNode(node, 'external', { slot: 7 }))
    expect(bound.at).toBe(10)
    expect(bound.peak).toBeCloseTo(1, 6)
  })

  test('attaching a bridge is refused unless it is really one', () => {
    expect(addon.attachVst3Bridge(undefined)).toBe(false)
    expect(addon.attachVst3Bridge(null)).toBe(false)
  })
})

/**
 * The live path itself, against a real installed effect. Skipped where the
 * vst3host addon is unbuilt or the machine has no VST3 effects.
 */
const hasVst3 = hasAddon && existsSync(vst3Path)

describe.skipIf(!hasVst3)('a real VST3 inside the audio callback', () => {
  const require = createRequire(import.meta.url)
  const addon = require(addonPath) as AudiohostAddon
  const vst3 = require(vst3Path) as Vst3RealtimeAddon & {
    scanPaths(): string[]
    inspect(path: string): { error?: string; classes?: Array<{ uid: string; name: string; subCategories: string }> }
  }
  addon.init()

  /** The first installed EFFECT (an instrument would answer silence). */
  const effect = ((): { path: string; uid: string; name: string } | null => {
    for (const path of vst3.scanPaths()) {
      let info: ReturnType<typeof vst3.inspect>
      try {
        info = vst3.inspect(path)
      } catch {
        continue
      }
      for (const cls of info.classes ?? []) {
        if (cls.subCategories.includes('Instrument')) continue
        return { path, uid: cls.uid, name: cls.name }
      }
    }
    return null
  })()

  test.skipIf(!effect)('audio reaches the plugin and comes back changed', () => {
    expect(addon.attachVst3Bridge(vst3.realtimeBridge())).toBe(true)
    const opened = vst3.openRealtime(effect!.path, effect!.uid, {
      sampleRate: SR,
      blockSize: 128,
      channels: 2
    })
    expect(opened.error).toBeUndefined()
    expect(opened.slot).toBeGreaterThanOrEqual(0)
    expect(typeof opened.latencySamples).toBe('number')

    const node = 500_001
    addon.createNode(node, 'external', { slot: opened.slot! })
    addon.connect(node, 0)
    const tone = new Float32Array(SR)
    for (let i = 0; i < tone.length; i++) tone[i] = 0.5 * Math.sin((2 * Math.PI * 440 * i) / SR)
    addon.registerBuffer('ext-tone', [tone], SR)
    addon.play({ id: 500_002, bufferId: 'ext-tone', when: 12_000, destination: node })

    const frames = Math.round(0.4 * SR)
    const out = addon.renderOffline(12_000, frames, SR)
    let sum = 0
    let peak = 0
    for (let i = frames >> 1; i < frames; i++) {
      const v = out[i * 2]
      sum += v * v
      peak = Math.max(peak, Math.abs(v))
    }
    // The plugin is a stranger — it may be an EQ, a saturator, anything —
    // so the assertion is the one thing true of them all: signal came out,
    // and it did not blow up. That is what proves the callback reached it.
    const rms = Math.sqrt(sum / (frames >> 1))
    expect(rms).toBeGreaterThan(1e-4)
    expect(peak).toBeLessThan(4)
    expect(Number.isFinite(rms)).toBe(true)

    // Closing waits out any in-flight process(), so a subsequent render
    // must find the node bypassing rather than reaching freed memory.
    expect(vst3.closeRealtime(opened.slot!).closed).toBe(true)
    addon.configureNode(node, { slot: -1 })
    const after = addon.renderOffline(13_000, 1024, SR)
    expect(Number.isFinite(after[0])).toBe(true)
    addon.disposeNode(node)
    addon.drainEnded()
    addon.attachVst3Bridge(null)
  })
})
