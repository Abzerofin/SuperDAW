import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import type { AudiohostAddon } from '../audioHostSession'

/**
 * Native biquad verification: steady-state sine gains measured from the
 * native engine's render, compared against |H(e^jω)| computed from an
 * INDEPENDENT JS transcription of the Web Audio / RBJ coefficient
 * formulas — two transcriptions must agree for a case to pass, so a slip
 * in either shows up. Covers every filter type the builtin effects use,
 * plus type switching via configureNode.
 */

const addonPath = join(process.cwd(), 'native/audiohost/build/Release/audiohost.node')
const hasAddon = existsSync(addonPath)

const SR = 48000

type BiquadKind =
  | 'lowpass'
  | 'highpass'
  | 'bandpass'
  | 'notch'
  | 'peaking'
  | 'lowshelf'
  | 'highshelf'

/** The reference transcription (RBJ cookbook / Web Audio spec, S = 1). */
function coefficients(
  type: BiquadKind,
  f0: number,
  q: number,
  gainDb: number
): { b0: number; b1: number; b2: number; a0: number; a1: number; a2: number } {
  const w0 = (2 * Math.PI * f0) / SR
  const cosw = Math.cos(w0)
  const sinw = Math.sin(w0)
  const A = Math.pow(10, gainDb / 40)
  const alphaQdB = (sinw / 2) * Math.pow(10, -q / 20)
  const alphaQ = sinw / (2 * q)
  const shelf = 2 * Math.sqrt(A) * ((sinw / 2) * Math.SQRT2)
  switch (type) {
    case 'lowpass':
      return {
        b0: (1 - cosw) / 2,
        b1: 1 - cosw,
        b2: (1 - cosw) / 2,
        a0: 1 + alphaQdB,
        a1: -2 * cosw,
        a2: 1 - alphaQdB
      }
    case 'highpass':
      return {
        b0: (1 + cosw) / 2,
        b1: -(1 + cosw),
        b2: (1 + cosw) / 2,
        a0: 1 + alphaQdB,
        a1: -2 * cosw,
        a2: 1 - alphaQdB
      }
    case 'bandpass':
      return { b0: alphaQ, b1: 0, b2: -alphaQ, a0: 1 + alphaQ, a1: -2 * cosw, a2: 1 - alphaQ }
    case 'notch':
      return { b0: 1, b1: -2 * cosw, b2: 1, a0: 1 + alphaQ, a1: -2 * cosw, a2: 1 - alphaQ }
    case 'peaking':
      return {
        b0: 1 + alphaQ * A,
        b1: -2 * cosw,
        b2: 1 - alphaQ * A,
        a0: 1 + alphaQ / A,
        a1: -2 * cosw,
        a2: 1 - alphaQ / A
      }
    case 'lowshelf':
      return {
        b0: A * (A + 1 - (A - 1) * cosw + shelf),
        b1: 2 * A * (A - 1 - (A + 1) * cosw),
        b2: A * (A + 1 - (A - 1) * cosw - shelf),
        a0: A + 1 + (A - 1) * cosw + shelf,
        a1: -2 * (A - 1 + (A + 1) * cosw),
        a2: A + 1 + (A - 1) * cosw - shelf
      }
    case 'highshelf':
      return {
        b0: A * (A + 1 + (A - 1) * cosw + shelf),
        b1: -2 * A * (A - 1 + (A + 1) * cosw),
        b2: A * (A + 1 + (A - 1) * cosw - shelf),
        a0: A + 1 - (A - 1) * cosw + shelf,
        a1: 2 * (A - 1 - (A + 1) * cosw),
        a2: A + 1 - (A - 1) * cosw - shelf
      }
  }
}

/** |H| at probe frequency, from the reference coefficients. */
function analyticGain(type: BiquadKind, f0: number, q: number, gainDb: number, probe: number): number {
  const { b0, b1, b2, a0, a1, a2 } = coefficients(type, f0, q, gainDb)
  const w = (2 * Math.PI * probe) / SR
  const mag = (r0: number, r1: number, r2: number): number => {
    const re = r0 + r1 * Math.cos(w) + r2 * Math.cos(2 * w)
    const im = -(r1 * Math.sin(w) + r2 * Math.sin(2 * w))
    return Math.hypot(re, im)
  }
  return mag(b0 / a0, b1 / a0, b2 / a0) / mag(1, a1 / a0, a2 / a0)
}

describe.skipIf(!hasAddon)('native biquad vs the spec formulas', () => {
  const require = createRequire(import.meta.url)
  const addon = require(addonPath) as AudiohostAddon
  addon.init()

  let nextId = 50_000
  let clock = 0

  /** Measured steady-state gain of a probe sine through one native biquad. */
  function measure(
    type: BiquadKind,
    f0: number,
    q: number,
    gainDb: number,
    probe: number,
    viaConfigure = false
  ): number {
    const t0 = clock
    clock += 0.7

    const filter = nextId++
    // Optionally create as peaking and switch — exercising configureNode.
    addon.createNode(filter, 'biquad', viaConfigure ? { type: 'peaking' } : { type })
    if (viaConfigure) addon.configureNode(filter, { type })
    addon.connect(filter, 0)
    addon.scheduleParam(filter, 'frequency', [{ kind: 'setValue', value: f0, time: 0 }])
    addon.scheduleParam(filter, 'Q', [{ kind: 'setValue', value: q, time: 0 }])
    addon.scheduleParam(filter, 'gain', [{ kind: 'setValue', value: gainDb, time: 0 }])

    const tone = new Float32Array(Math.round(0.6 * SR))
    for (let i = 0; i < tone.length; i++) tone[i] = Math.sin((2 * Math.PI * probe * i) / SR)
    const bufferId = `probe-${nextId++}`
    addon.registerBuffer(bufferId, [tone], SR)
    addon.play({ id: nextId++, bufferId, when: t0 + 0.02, destination: filter })

    const out = addon.renderOffline(t0, Math.round(0.7 * SR), SR)
    const from = Math.round(0.4 * SR)
    const to = Math.round(0.6 * SR)
    let sum = 0
    for (let i = from; i < to; i++) sum += out[i * 2] * out[i * 2]
    const rms = Math.sqrt(sum / (to - from))

    addon.disposeNode(filter)
    addon.releaseBuffer(bufferId)
    addon.drainEnded()
    return rms * Math.SQRT2 // amplitude gain (input amplitude 1)
  }

  const cases: Array<[BiquadKind, number, number, number, number]> = [
    // [type, f0, Q (dB for lp/hp, linear otherwise), gainDb, probeHz]
    ['lowpass', 1000, 0, 0, 250],
    ['lowpass', 1000, 0, 0, 1000],
    ['lowpass', 1000, 0, 0, 4000],
    ['lowpass', 1000, 6, 0, 1000], // resonant peak, Q in dB
    ['highpass', 500, 0, 0, 4000],
    ['highpass', 500, 0, 0, 125],
    ['bandpass', 1000, 2, 0, 1000],
    ['bandpass', 1000, 2, 0, 250],
    ['peaking', 1000, 1, 6, 1000],
    ['peaking', 1000, 1, 6, 100],
    ['lowshelf', 200, 1, 6, 50],
    ['lowshelf', 200, 1, 6, 2000],
    ['highshelf', 4000, 1, -6, 12000],
    ['highshelf', 4000, 1, -6, 500]
  ]

  for (const [type, f0, q, gainDb, probe] of cases) {
    test(`${type} f0=${f0} Q=${q} gain=${gainDb} @ ${probe} Hz`, () => {
      const measured = measure(type, f0, q, gainDb, probe)
      const expected = analyticGain(type, f0, q, gainDb, probe)
      expect(measured).toBeGreaterThan(expected * 0.985)
      expect(measured).toBeLessThan(expected * 1.015)
    })
  }

  test('notch kills its center frequency (via configureNode switching)', () => {
    const atCenter = measure('notch', 1000, 5, 0, 1000, true)
    const offCenter = measure('notch', 1000, 5, 0, 400, true)
    expect(atCenter).toBeLessThan(0.02)
    expect(offCenter).toBeGreaterThan(0.9)
  })
})
