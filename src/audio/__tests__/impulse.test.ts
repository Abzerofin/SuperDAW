import { describe, expect, test } from 'vitest'
import { makeProImpulse, proImpulseBufferId, type ProImpulseParams } from '../impulse'

/**
 * The Reverb Pro impulse is GENERATED audio that lands in shared bounces
 * and freezes, so beyond sounding right it must be bit-deterministic for
 * a given (rate, params) tuple on every machine — the collaboration
 * invariant the parity harness leans on.
 */

const SR = 48000

const params = (over: Partial<ProImpulseParams> = {}): ProImpulseParams => ({
  decaySeconds: 1,
  damping: 0.5,
  size: 0.3,
  width: 1,
  ...over
})

/** RMS of a slice. */
function rms(data: Float32Array, from: number, to: number): number {
  let sum = 0
  for (let i = from; i < to; i++) sum += data[i] * data[i]
  return Math.sqrt(sum / Math.max(1, to - from))
}

/** Ratio of first-difference energy to signal energy — a HF-content proxy. */
function hfRatio(data: Float32Array, from: number, to: number): number {
  let diff = 0
  let total = 0
  for (let i = Math.max(1, from); i < to; i++) {
    const d = data[i] - data[i - 1]
    diff += d * d
    total += data[i] * data[i]
  }
  return total > 0 ? diff / total : 0
}

describe('makeProImpulse', () => {
  test('is deterministic: same params, same bytes, every call', () => {
    const a = makeProImpulse(SR, params())
    const b = makeProImpulse(SR, params())
    expect(a.length).toBe(2)
    for (let ch = 0; ch < 2; ch++) {
      expect(a[ch].length).toBe(b[ch].length)
      for (let i = 0; i < a[ch].length; i++) {
        if (a[ch][i] !== b[ch][i]) {
          throw new Error(`channel ${ch} diverges at sample ${i}`)
        }
      }
    }
  })

  test('length tracks the decay time exactly', () => {
    for (const decay of [0.2, 1, 3.7, 10]) {
      const channels = makeProImpulse(SR, params({ decaySeconds: decay }))
      expect(channels[0].length).toBe(Math.round(SR * decay))
      expect(channels[1].length).toBe(Math.round(SR * decay))
    }
  })

  test('envelope decays monotonically after the attack bloom', () => {
    const [left] = makeProImpulse(SR, params({ size: 0, damping: 0.3 }))
    const windowLen = Math.round(SR * 0.05)
    const windows = Math.floor(left.length / windowLen)
    let prev = rms(left, windowLen, 2 * windowLen) // skip window 0 (attack)
    expect(prev).toBeGreaterThan(0)
    for (let w = 2; w < windows; w++) {
      const value = rms(left, w * windowLen, (w + 1) * windowLen)
      // Strictly shrinking envelope, small slack for noise variance.
      expect(value).toBeLessThan(prev * 1.02)
      prev = value
    }
    // -60 dB target: the tail's end is far below its start.
    expect(rms(left, left.length - windowLen, left.length)).toBeLessThan(
      rms(left, windowLen, 2 * windowLen) * 0.01
    )
  })

  test('damping progressively removes highs along the tail', () => {
    const bright = makeProImpulse(SR, params({ damping: 0 }))[0]
    const damped = makeProImpulse(SR, params({ damping: 1 }))[0]
    const from = Math.round(bright.length * 0.75)
    const brightHf = hfRatio(bright, from, bright.length)
    const dampedHf = hfRatio(damped, from, damped.length)
    expect(dampedHf).toBeLessThan(brightHf * 0.5)
    // ... and damping is PROGRESSIVE: the damped tail's end is duller than
    // its own start.
    const earlyTo = Math.round(damped.length * 0.25)
    expect(dampedHf).toBeLessThan(hfRatio(damped, 0, earlyTo) * 0.7)
  })

  test('width 0 collapses to mono, width 1 decorrelates the channels', () => {
    const mono = makeProImpulse(SR, params({ width: 0, decaySeconds: 0.5 }))
    for (let i = 0; i < mono[0].length; i++) {
      if (mono[0][i] !== mono[1][i]) throw new Error(`mono channels diverge at ${i}`)
    }
    const wide = makeProImpulse(SR, params({ width: 1, decaySeconds: 0.5 }))
    let dot = 0
    let energyL = 0
    let energyR = 0
    for (let i = 0; i < wide[0].length; i++) {
      dot += wide[0][i] * wide[1][i]
      energyL += wide[0][i] * wide[0][i]
      energyR += wide[1][i] * wide[1][i]
    }
    const correlation = dot / Math.sqrt(energyL * energyR)
    expect(Math.abs(correlation)).toBeLessThan(0.2)
    // The decorrelation mix is energy-normalized: width must not change
    // loudness.
    const monoEnergy = rms(mono[0], 0, mono[0].length)
    const wideEnergy = rms(wide[0], 0, wide[0].length)
    expect(wideEnergy).toBeGreaterThan(monoEnergy * 0.75)
    expect(wideEnergy).toBeLessThan(monoEnergy * 1.25)
  })
})

describe('proImpulseBufferId', () => {
  test('is stable for equal params and distinct across any shaping change', () => {
    const base = params()
    expect(proImpulseBufferId(base, SR)).toBe(proImpulseBufferId({ ...base }, SR))
    const ids = new Set([
      proImpulseBufferId(base, SR),
      proImpulseBufferId({ ...base, decaySeconds: 2 }, SR),
      proImpulseBufferId({ ...base, damping: 0.9 }, SR),
      proImpulseBufferId({ ...base, size: 0.9 }, SR),
      proImpulseBufferId({ ...base, width: 0.1 }, SR),
      proImpulseBufferId(base, 44100)
    ])
    expect(ids.size).toBe(6)
  })

  test('quantizes to two decimals — sub-threshold wiggle reuses the buffer', () => {
    expect(proImpulseBufferId(params({ damping: 0.5004 }), SR)).toBe(
      proImpulseBufferId(params({ damping: 0.4996 }), SR)
    )
  })
})
