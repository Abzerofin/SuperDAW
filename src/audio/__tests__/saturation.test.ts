import { describe, expect, test } from 'vitest'
import {
  makeShaperCurve,
  saturate,
  saturatorTiltDb,
  SHAPER_CURVE_LENGTH
} from '../saturation'

/**
 * The Saturator's shaper curve is pure math shared by the live engine, the
 * offline render and the card visual — so its symmetry, bounds and gain
 * compensation are testable without an audio graph.
 */

const DRIVES = [0, 3, 6, 12, 24, 36]

describe('saturate', () => {
  test('maps zero to zero and is odd-symmetric', () => {
    for (const drive of DRIVES) {
      expect(saturate(0, drive)).toBe(0)
      for (const x of [0.1, 0.35, 0.7, 1]) {
        expect(saturate(-x, drive)).toBeCloseTo(-saturate(x, drive), 10)
      }
    }
  })

  test('holds the reference level still whatever the drive (gain compensation)', () => {
    for (const drive of DRIVES) {
      expect(saturate(0.5, drive)).toBeCloseTo(0.5, 10)
    }
  })

  test('raising drive never makes the peak louder', () => {
    let prev = Number.POSITIVE_INFINITY
    for (const drive of DRIVES) {
      const peak = saturate(1, drive)
      expect(peak).toBeLessThanOrEqual(prev)
      prev = peak
    }
  })
})

describe('makeShaperCurve', () => {
  test('has an odd length with an exact zero center', () => {
    const curve = makeShaperCurve(12)
    expect(curve.length).toBe(SHAPER_CURVE_LENGTH)
    expect(SHAPER_CURVE_LENGTH % 2).toBe(1)
    expect(curve[(SHAPER_CURVE_LENGTH - 1) / 2]).toBe(0)
  })

  test('is bounded and monotonically increasing at every drive', () => {
    for (const drive of DRIVES) {
      const curve = makeShaperCurve(drive)
      for (let i = 0; i < curve.length; i++) {
        expect(Math.abs(curve[i])).toBeLessThanOrEqual(1.1)
        if (i > 0) expect(curve[i]).toBeGreaterThanOrEqual(curve[i - 1])
      }
    }
  })

  test('mirrors saturate() and is odd-symmetric across the center', () => {
    const curve = makeShaperCurve(18)
    for (let i = 0; i < curve.length; i++) {
      const x = (2 * i) / (curve.length - 1) - 1
      expect(curve[i]).toBeCloseTo(saturate(x, 18), 6)
      expect(curve[i]).toBeCloseTo(-curve[curve.length - 1 - i], 6)
    }
  })

  test('is deterministic — same drive, same curve', () => {
    const a = makeShaperCurve(9.5)
    const b = makeShaperCurve(9.5)
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) throw new Error(`curve diverges at ${i}`)
    }
  })
})

describe('saturatorTiltDb', () => {
  test('centers at zero and tilts symmetrically', () => {
    expect(saturatorTiltDb(0.5)).toBe(0)
    expect(saturatorTiltDb(1)).toBe(6)
    expect(saturatorTiltDb(0)).toBe(-6)
    expect(saturatorTiltDb(0.75)).toBeCloseTo(-saturatorTiltDb(0.25), 10)
  })
})
