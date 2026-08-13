import { expect, suite, test } from 'vitest'
import {
  CHIRP_SECONDS,
  MIN_CONFIDENCE,
  findChirp,
  generateChirp,
  summarizeMeasurements
} from '../calibration'

const RATE = 48000

/** Deterministic PRNG (mulberry32) so noise tests can never flake. */
function makeRandom(seed: number): () => number {
  let state = seed
  return () => {
    state = (state + 0x6d2b79f5) | 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** A capture holding the sweep at `delay`, scaled, over optional noise. */
function captureWith(
  reference: Float32Array,
  delay: number,
  scale: number,
  noiseAmp = 0,
  seed = 1
): Float32Array {
  const random = makeRandom(seed)
  const out = new Float32Array(delay + reference.length + Math.round(0.1 * RATE))
  for (let i = 0; i < out.length; i++) out[i] = noiseAmp * (random() * 2 - 1)
  for (let i = 0; i < reference.length; i++) out[delay + i] += scale * reference[i]
  return out
}

suite('generateChirp', () => {
  test('has the documented length, stays in range, starts and ends silent', () => {
    const chirp = generateChirp(RATE)
    expect(chirp.length).toBe(Math.round(CHIRP_SECONDS * RATE))
    let peak = 0
    for (const v of chirp) peak = Math.max(peak, Math.abs(v))
    expect(peak).toBeLessThanOrEqual(1)
    expect(peak).toBeGreaterThan(0.9)
    expect(Math.abs(chirp[0])).toBeLessThan(1e-6)
    expect(Math.abs(chirp[chirp.length - 1])).toBeLessThan(0.02)
  })
})

suite('findChirp', () => {
  test('recovers an exact delay with high confidence', () => {
    const reference = generateChirp(RATE)
    const match = findChirp(captureWith(reference, 12345, 1), reference, RATE)
    expect(match).not.toBeNull()
    expect(match!.lagSamples).toBe(12345)
    expect(match!.confidence).toBeGreaterThan(MIN_CONFIDENCE)
  })

  test('zero delay (sweep at the very start) is found', () => {
    const reference = generateChirp(RATE)
    const match = findChirp(captureWith(reference, 0, 1), reference, RATE)
    expect(match!.lagSamples).toBe(0)
  })

  test('survives attenuation, inverted polarity and noise', () => {
    const reference = generateChirp(RATE)
    // 5% level, inverted, under noise of comparable amplitude — the
    // matched filter's ~110× processing gain is what carries this.
    const capture = captureWith(reference, 4321, -0.05, 0.04)
    const match = findChirp(capture, reference, RATE)
    expect(match).not.toBeNull()
    expect(Math.abs(match!.lagSamples - 4321)).toBeLessThanOrEqual(1)
    expect(match!.confidence).toBeGreaterThan(MIN_CONFIDENCE)
  })

  test('pure noise reads as low confidence, never a confident lie', () => {
    const reference = generateChirp(RATE)
    const capture = captureWith(reference, 0, 0, 0.1, 7)
    const match = findChirp(capture, reference, RATE)
    if (match !== null) expect(match.confidence).toBeLessThan(MIN_CONFIDENCE)
  })

  test('digital silence returns null rather than a peak', () => {
    const reference = generateChirp(RATE)
    expect(findChirp(new Float32Array(RATE), reference, RATE)).toBeNull()
  })

  test('a capture shorter than the reference is rejected', () => {
    const reference = generateChirp(RATE)
    expect(findChirp(new Float32Array(100), reference, RATE)).toBeNull()
  })
})

suite('summarizeMeasurements', () => {
  test('odd count takes the median, spread is max − min', () => {
    const summary = summarizeMeasurements([0.021, 0.02, 0.0202])
    expect(summary!.roundTripSec).toBeCloseTo(0.0202, 10)
    expect(summary!.spreadSec).toBeCloseTo(0.001, 10)
  })

  test('even count averages the middle pair', () => {
    const summary = summarizeMeasurements([0.01, 0.02, 0.03, 0.04])
    expect(summary!.roundTripSec).toBeCloseTo(0.025, 10)
  })

  test('empty input yields null', () => {
    expect(summarizeMeasurements([])).toBeNull()
  })

  test('an outlier repeat shifts the median barely, the spread loudly', () => {
    // The store's gate reads the spread; this is the shape it relies on.
    const summary = summarizeMeasurements([0.02, 0.0201, 0.3])
    expect(summary!.roundTripSec).toBeCloseTo(0.0201, 10)
    expect(summary!.spreadSec).toBeGreaterThan(0.2)
  })
})
