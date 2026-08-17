import { describe, expect, it } from 'vitest'
import { FMAX, FMIN, freqToX } from '../biquad'
import {
  PEAK_DECAY_DB_PER_FRAME,
  SPECTRUM_CEIL_DB,
  SPECTRUM_FLOOR_DB,
  binFrequency,
  binToX,
  dbToY,
  decayPeakHold,
  xToBin
} from '../spectrum'

// The analyzer's real geometry: fftSize 4096 at 48 kHz → 2048 bins.
const BINS = 2048
const SR = 48000
const W = 520
const H = 180

describe('binFrequency', () => {
  it('spans DC to Nyquist linearly', () => {
    expect(binFrequency(0, BINS, SR)).toBe(0)
    expect(binFrequency(BINS, BINS, SR)).toBe(SR / 2)
    expect(binFrequency(BINS / 2, BINS, SR)).toBeCloseTo(SR / 4)
  })

  it('one bin is sampleRate / fftSize wide', () => {
    expect(binFrequency(1, BINS, SR)).toBeCloseTo(SR / (2 * BINS)) // 11.72 Hz
  })
})

describe('binToX', () => {
  it('matches the log axis the EQ curves use', () => {
    // The bin nearest 1 kHz must land where freqToX puts 1 kHz (within
    // the width of one bin on the log axis).
    const bin = Math.round((1000 / (SR / 2)) * BINS)
    const f = binFrequency(bin, BINS, SR)
    expect(binToX(bin, BINS, SR, W)).toBeCloseTo(freqToX(f, W), 10)
  })

  it('clamps sub-audible and DC bins to the left edge', () => {
    expect(binToX(0, BINS, SR, W)).toBe(freqToX(FMIN, W))
    expect(binToX(0, BINS, SR, W)).toBe(0)
    // 11.72 Hz — below the 20 Hz window — also pins left.
    expect(binToX(1, BINS, SR, W)).toBe(0)
  })

  it('clamps ultrasonic bins to the right edge', () => {
    expect(binToX(BINS, BINS, SR, W)).toBeCloseTo(freqToX(FMAX, W), 10)
    expect(binToX(BINS, BINS, SR, W)).toBeCloseTo(W, 10)
  })

  it('is monotonic across the audible bins', () => {
    let prev = -1
    for (let bin = 2; bin < BINS; bin += 16) {
      const x = binToX(bin, BINS, SR, W)
      expect(x).toBeGreaterThanOrEqual(prev)
      prev = x
    }
  })
})

describe('xToBin', () => {
  it('round-trips with binToX across the audible window', () => {
    for (const x of [0, 37, 130, 260, 390, W]) {
      const bin = xToBin(x, W, BINS, SR)
      expect(binToX(bin, BINS, SR, W)).toBeCloseTo(x, 6)
    }
  })

  it('never exceeds the last real bin', () => {
    expect(xToBin(W, W, BINS, SR)).toBeLessThanOrEqual(BINS - 1)
    expect(xToBin(0, W, BINS, SR)).toBeGreaterThan(0) // 20 Hz is above DC
  })
})

describe('dbToY', () => {
  it('puts the ceiling at the top and the floor at the bottom', () => {
    expect(dbToY(SPECTRUM_CEIL_DB, H)).toBe(0)
    expect(dbToY(SPECTRUM_FLOOR_DB, H)).toBe(H)
    expect(dbToY(-45, H)).toBe(H / 2)
  })

  it('clamps out-of-range values (getFloatFrequencyData yields -Infinity)', () => {
    expect(dbToY(12, H)).toBe(0)
    expect(dbToY(-200, H)).toBe(H)
    expect(dbToY(Number.NEGATIVE_INFINITY, H)).toBe(H)
  })
})

describe('decayPeakHold', () => {
  it('captures a louder live value instantly', () => {
    const peaks = new Float32Array([-60, -60])
    decayPeakHold(peaks, new Float32Array([-20, -80]))
    expect(peaks[0]).toBeCloseTo(-20)
    expect(peaks[1]).toBeCloseTo(-60 - PEAK_DECAY_DB_PER_FRAME)
  })

  it('decays by exactly one frame step when the live value is below', () => {
    const peaks = new Float32Array([-30])
    decayPeakHold(peaks, new Float32Array([-90]), 0.5)
    expect(peaks[0]).toBeCloseTo(-30.5)
  })

  it('keeps falling through silence (-Infinity live values)', () => {
    const peaks = new Float32Array([-88])
    const silent = new Float32Array([Number.NEGATIVE_INFINITY])
    for (let i = 0; i < 10; i++) decayPeakHold(peaks, silent, 1)
    expect(peaks[0]).toBeCloseTo(-98)
  })
})
