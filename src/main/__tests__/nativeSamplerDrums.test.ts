import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { makeNoise } from '../../audio/impulse'
import type { AudiohostAddon } from '../audioHostSession'

/**
 * The two capabilities the sampler and drum synth needed from the native
 * engine beyond what was already there: buffer LOOP points (the sampler's
 * sustain loop) and EXPONENTIAL param ramps (every drum decay envelope,
 * and the kick/tom pitch drops).
 */

const addonPath = join(process.cwd(), 'native/audiohost/build/Release/audiohost.node')
const hasAddon = existsSync(addonPath)

const SR = 48000

describe.skipIf(!hasAddon)('native sampler loop + drum envelopes', () => {
  const require = createRequire(import.meta.url)
  const addon = require(addonPath) as AudiohostAddon
  addon.init()
  let id = 30_000
  let clock = 2000

  function rms(out: Float32Array, fromSec: number, toSec: number): number {
    let sum = 0
    const from = Math.round(fromSec * SR)
    const to = Math.round(toSec * SR)
    for (let i = from; i < to; i++) sum += out[i * 2] * out[i * 2]
    return Math.sqrt(sum / Math.max(1, to - from))
  }

  test('a looped buffer repeats its region instead of ending', () => {
    const t0 = clock
    clock += 3

    // A 1 s buffer that is LOUD only in [0.1, 0.2) — looping that region
    // must keep producing sound long past the buffer's natural end.
    const data = new Float32Array(SR)
    for (let i = Math.round(0.1 * SR); i < Math.round(0.2 * SR); i++) {
      data[i] = 0.8 * Math.sin((2 * Math.PI * 440 * i) / SR)
    }
    addon.registerBuffer('loopy', [data], SR)

    const voice = id++
    addon.play({
      id: voice,
      bufferId: 'loopy',
      when: t0,
      offsetSec: 0.1,
      rate: 1,
      loop: { startSec: 0.1, endSec: 0.2 },
      destination: 0
    })
    const out = addon.renderOffline(t0, Math.round(2.5 * SR), SR)

    // Sound throughout, including well beyond the 1 s buffer — only a
    // working loop can do that (the region is silent everywhere else).
    expect(rms(out, 0.0, 0.09)).toBeGreaterThan(0.3)
    expect(rms(out, 1.2, 1.4)).toBeGreaterThan(0.3)
    expect(rms(out, 2.2, 2.4)).toBeGreaterThan(0.3)
    // And it never ends by itself.
    expect(addon.drainEnded()).not.toContain(voice)

    addon.stopVoice(voice)
    addon.releaseBuffer('loopy')
    addon.drainEnded()
  })

  test('an exponential ramp decays multiplicatively, not linearly', () => {
    const t0 = clock
    clock += 3

    // A steady tone through a gain that decays 1 → 0.001 over 1 s. At the
    // halfway point an EXPONENTIAL ramp reads sqrt(1·0.001) ≈ 0.0316,
    // where a linear one would read ≈ 0.5 — the two are unmistakable.
    const gain = id++
    addon.createNode(gain, 'gain')
    addon.scheduleParam(gain, 'gain', [
      { kind: 'setValue', value: 1, time: t0 },
      { kind: 'exponentialRamp', value: 0.001, endTime: t0 + 1 }
    ])
    addon.connect(gain, 0)
    const osc = id++
    addon.createNode(osc, 'oscillator', { type: 'sine' })
    addon.scheduleParam(osc, 'frequency', [{ kind: 'setValue', value: 500, time: 0 }])
    addon.connect(osc, gain)
    addon.scheduleSource(id++, osc, t0, t0 + 1.2)

    const out = addon.renderOffline(t0, Math.round(1.1 * SR), SR)
    const mid = rms(out, 0.48, 0.52) * Math.SQRT2 // amplitude at the middle
    expect(mid).toBeGreaterThan(0.02)
    expect(mid).toBeLessThan(0.05) // ~0.0316, nowhere near a linear 0.5

    for (const n of [gain, osc]) addon.disposeNode(n)
    addon.drainEnded()
  })

  test('a drum hit: filtered noise under an exponential decay', () => {
    const t0 = clock
    clock += 3

    // The closed-hat shape: highpassed noise, 55 ms exponential decay.
    const noiseId = `noise-${SR}`
    addon.registerBuffer(noiseId, makeNoise(SR), SR)
    const filter = id++
    addon.createNode(filter, 'biquad', { type: 'highpass' })
    addon.scheduleParam(filter, 'frequency', [{ kind: 'setValue', value: 7500, time: 0 }])
    addon.scheduleParam(filter, 'Q', [{ kind: 'setValue', value: 0.7, time: 0 }])
    const env = id++
    addon.createNode(env, 'gain')
    addon.scheduleParam(env, 'gain', [
      { kind: 'setValue', value: 0.8, time: t0 },
      { kind: 'exponentialRamp', value: 0.001, endTime: t0 + 0.055 }
    ])
    addon.connect(filter, env)
    addon.connect(env, 0)
    const voice = id++
    addon.play({
      id: voice,
      bufferId: noiseId,
      when: t0,
      offsetSec: 0,
      durationSec: 0.105,
      destination: filter
    })

    const out = addon.renderOffline(t0, Math.round(0.4 * SR), SR)
    // A sharp transient that is essentially gone by ~60 ms.
    const attack = rms(out, 0.002, 0.01)
    const tail = rms(out, 0.08, 0.2)
    expect(attack).toBeGreaterThan(0.05)
    expect(tail).toBeLessThan(attack * 0.05)
    expect(addon.drainEnded()).toContain(voice)

    for (const n of [filter, env]) addon.disposeNode(n)
    addon.releaseBuffer(noiseId)
  })
})
