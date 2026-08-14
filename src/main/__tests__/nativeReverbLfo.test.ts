import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { makeImpulse } from '../../audio/impulse'
import type { AudiohostAddon } from '../audioHostSession'

/**
 * Native convolver and oscillator.
 *
 * Convolution is exact math, so unlike the compressor this admits a real
 * ground truth: an impulse through the convolver must reproduce the
 * (normalized) impulse response sample for sample. The normalization is
 * the part that had to be MEASURED off Chromium's ConvolverNode —
 * `normalize` defaults to true and scales by
 * 10^(−58/20) · (44100/sampleRate) / rms, a law recovered from the real
 * node and asserted here against an independent computation.
 */

const addonPath = join(process.cwd(), 'native/audiohost/build/Release/audiohost.node')
const hasAddon = existsSync(addonPath)

const SR = 48000

describe.skipIf(!hasAddon)('native convolver', () => {
  const require = createRequire(import.meta.url)
  const addon = require(addonPath) as AudiohostAddon
  addon.init()
  let id = 40_000
  let clock = 0

  test('an impulse reproduces the normalized impulse response exactly', () => {
    const t0 = clock
    clock += 2

    const decay = 0.3
    const ir = makeImpulse(SR, decay)
    addon.registerBuffer('ir-test', ir, SR)
    const conv = id++
    addon.createNode(conv, 'convolver')
    addon.configureNode(conv, { buffer: 'ir-test' })
    addon.connect(conv, 0)

    const click = new Float32Array(256)
    click[0] = 1
    addon.registerBuffer('click', [click], SR)
    addon.play({ id: id++, bufferId: 'click', when: t0, destination: conv })

    const frames = ir[0].length + 512
    const out = addon.renderOffline(t0, frames, SR)

    // The scale Chromium applies: measured law, computed independently here.
    let power = 0
    for (const ch of ir) for (const v of ch) power += v * v
    power = Math.sqrt(power / (ir.length * ir[0].length))
    const expectedScale = (Math.pow(10, -58 / 20) / power) * (44100 / SR)

    // Sample-for-sample against the scaled impulse response.
    let maxErr = 0
    let peak = 0
    for (let i = 0; i < ir[0].length; i++) {
      const want = ir[0][i] * expectedScale
      maxErr = Math.max(maxErr, Math.abs(out[i * 2] - want))
      peak = Math.max(peak, Math.abs(want))
    }
    expect(peak).toBeGreaterThan(1e-4) // the test is actually exercising signal
    // Float32 + FFT round-off only: relative error well under a thousandth.
    expect(maxErr / peak).toBeLessThan(1e-3)

    addon.disposeNode(conv)
    addon.releaseBuffer('ir-test')
    addon.releaseBuffer('click')
    addon.drainEnded()
  })

  test('convolution is linear across block boundaries (a tail survives)', () => {
    const t0 = clock
    clock += 3

    const ir = makeImpulse(SR, 0.5)
    addon.registerBuffer('ir-tail', ir, SR)
    const conv = id++
    addon.createNode(conv, 'convolver')
    addon.configureNode(conv, { buffer: 'ir-tail' })
    addon.connect(conv, 0)

    // A short burst: the reverb tail must continue long after it ends.
    const burst = new Float32Array(Math.round(0.02 * SR))
    for (let i = 0; i < burst.length; i++) burst[i] = Math.sin((2 * Math.PI * 300 * i) / SR)
    addon.registerBuffer('burst', [burst], SR)
    addon.play({ id: id++, bufferId: 'burst', when: t0, destination: conv })

    const out = addon.renderOffline(t0, Math.round(0.6 * SR), SR)
    const rms = (fromSec: number, toSec: number): number => {
      let sum = 0
      const from = Math.round(fromSec * SR)
      const to = Math.round(toSec * SR)
      for (let i = from; i < to; i++) sum += out[i * 2] * out[i * 2]
      return Math.sqrt(sum / (to - from))
    }
    // Energy well past the burst (many blocks later), decaying toward the end.
    expect(rms(0.1, 0.2)).toBeGreaterThan(1e-5)
    expect(rms(0.1, 0.2)).toBeGreaterThan(rms(0.4, 0.5))

    addon.disposeNode(conv)
    addon.releaseBuffer('ir-tail')
    addon.releaseBuffer('burst')
    addon.drainEnded()
  })
})

describe.skipIf(!hasAddon)('native oscillator + param modulation', () => {
  const require = createRequire(import.meta.url)
  const addon = require(addonPath) as AudiohostAddon
  addon.init()
  let id = 45_000
  let clock = 100

  test('an oscillator modulating a gain produces tremolo at the LFO rate', () => {
    const t0 = clock
    clock += 3

    // The tremolo topology: carrier gain at 1 − depth/2, oscillator × depth/2
    // summed into the carrier's gain param.
    const depth = 0.8
    const carrier = id++
    addon.createNode(carrier, 'gain')
    addon.scheduleParam(carrier, 'gain', [
      { kind: 'setValue', value: 1 - depth / 2, time: 0 }
    ])
    addon.connect(carrier, 0)
    const depthGain = id++
    addon.createNode(depthGain, 'gain')
    addon.scheduleParam(depthGain, 'gain', [{ kind: 'setValue', value: depth / 2, time: 0 }])
    const osc = id++
    addon.createNode(osc, 'oscillator', { type: 'sine' })
    addon.scheduleParam(osc, 'frequency', [{ kind: 'setValue', value: 5, time: 0 }])
    addon.connect(osc, depthGain)
    addon.connectParam(depthGain, carrier, 'gain')

    // A steady tone through the carrier: its ENVELOPE should sweep.
    const tone = new Float32Array(Math.round(1.0 * SR))
    for (let i = 0; i < tone.length; i++) tone[i] = Math.sin((2 * Math.PI * 400 * i) / SR)
    addon.registerBuffer('lfo-tone', [tone], SR)
    addon.play({ id: id++, bufferId: 'lfo-tone', when: t0, destination: carrier })

    const out = addon.renderOffline(t0, Math.round(1.0 * SR), SR)
    // Envelope over 10 ms windows; at 5 Hz the level must swing between
    // (1 − depth) and 1 — five full cycles across the second.
    const env: number[] = []
    const win = Math.round(0.01 * SR)
    for (let start = 0; start + win < Math.round(1.0 * SR); start += win) {
      let peak = 0
      for (let i = start; i < start + win; i++) peak = Math.max(peak, Math.abs(out[i * 2]))
      env.push(peak)
    }
    const maxEnv = Math.max(...env)
    const minEnv = Math.min(...env)
    expect(maxEnv).toBeGreaterThan(0.9) // reaches ~1
    expect(minEnv).toBeLessThan(1 - depth + 0.1) // dips to ~0.2
    // Count envelope peaks: 5 Hz over 1 s.
    let crossings = 0
    const mid = (maxEnv + minEnv) / 2
    for (let i = 1; i < env.length; i++) {
      if (env[i - 1] < mid && env[i] >= mid) crossings++
    }
    expect(crossings).toBeGreaterThanOrEqual(4)
    expect(crossings).toBeLessThanOrEqual(6)

    addon.disconnectParam(depthGain, carrier, 'gain')
    for (const n of [osc, depthGain, carrier]) addon.disposeNode(n)
    addon.releaseBuffer('lfo-tone')
    addon.drainEnded()
  })

  test('square and sawtooth run at the requested frequency', () => {
    for (const type of ['square', 'sawtooth'] as const) {
      const t0 = clock
      clock += 2
      const osc = id++
      addon.createNode(osc, 'oscillator', { type })
      addon.scheduleParam(osc, 'frequency', [{ kind: 'setValue', value: 100, time: 0 }])
      addon.connect(osc, 0)
      const out = addon.renderOffline(t0, Math.round(0.5 * SR), SR)
      let crossings = 0
      for (let i = 1; i < Math.round(0.5 * SR); i++) {
        if (out[(i - 1) * 2] < 0 && out[i * 2] >= 0) crossings++
      }
      // 100 Hz over 0.5 s = 50 rising zero crossings.
      expect(crossings).toBeGreaterThanOrEqual(49)
      expect(crossings).toBeLessThanOrEqual(51)
      addon.disposeNode(osc)
    }
  })
})
