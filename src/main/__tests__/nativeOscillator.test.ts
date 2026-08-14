import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import type { AudiohostAddon } from '../audioHostSession'

/**
 * Native band-limited oscillator vs the REAL OscillatorNode.
 *
 * The reference numbers were MEASURED from Chromium (offline renders in
 * the dev page, 48 kHz) — harmonic amplitudes and single-cycle shapes —
 * so this is a cross-implementation check, not a transcription agreeing
 * with itself. What the measurements established, and what this pins:
 *
 *  - the series are textbook, but every table shares ONE normalization
 *    scale chosen so the fullest table peaks at 1.0. That is why saw and
 *    square harmonics read 0.8483× the ideal (1/1.179 — the Gibbs
 *    overshoot for a jump of 2) while sine and triangle read 1.0×.
 *  - band-limiting is the whole point: a naive saw at a musical pitch
 *    folds everything above Nyquist back as inharmonic junk, which the
 *    aliasing test below would catch.
 */

const addonPath = join(process.cwd(), 'native/audiohost/build/Release/audiohost.node')
const hasAddon = existsSync(addonPath)

const SR = 48000

describe.skipIf(!hasAddon)('native band-limited oscillator', () => {
  const require = createRequire(import.meta.url)
  const addon = require(addonPath) as AudiohostAddon
  addon.init()
  let id = 60_000
  let clock = 500

  /** Render one oscillator alone and return the samples. */
  function render(type: string, freq: number, seconds: number): Float32Array {
    const t0 = clock
    clock += seconds + 1
    const osc = id++
    addon.createNode(osc, 'oscillator', { type })
    addon.scheduleParam(osc, 'frequency', [{ kind: 'setValue', value: freq, time: 0 }])
    addon.connect(osc, 0)
    const out = addon.renderOffline(t0, Math.round(seconds * SR), SR)
    addon.disposeNode(osc)
    const mono = new Float32Array(Math.round(seconds * SR))
    for (let i = 0; i < mono.length; i++) mono[i] = out[i * 2]
    return mono
  }

  /** Amplitude at a frequency (Goertzel over the whole buffer). */
  function amplitudeAt(data: Float32Array, freq: number): number {
    const w = (2 * Math.PI * freq) / SR
    let re = 0
    let im = 0
    for (let i = 0; i < data.length; i++) {
      re += data[i] * Math.cos(w * i)
      im += data[i] * Math.sin(w * i)
    }
    return (2 * Math.hypot(re, im)) / data.length
  }

  // Measured from Chromium: sawtooth at 110 Hz, harmonics 1..8.
  const CHROMIUM_SAW_110 = [0.53981, 0.27031, 0.18063, 0.13588, 0.10908, 0.09122, 0.07845, 0.06885]

  test('sawtooth harmonics match Chromium (shared unit-peak normalization)', () => {
    const data = render('sawtooth', 110, 0.35)
    CHROMIUM_SAW_110.forEach((expected, index) => {
      const measured = amplitudeAt(data, 110 * (index + 1))
      // Within 3% — the series and scale agree; only table interpolation
      // and finite-window leakage separate them.
      expect(Math.abs(measured - expected) / expected).toBeLessThan(0.03)
    })
  })

  test('sine and triangle are NOT scaled down (no jump, so no Gibbs)', () => {
    // Chromium: sine peaks at exactly 1.0, triangle at ~0.998.
    const sine = render('sine', 220, 0.2)
    expect(amplitudeAt(sine, 220)).toBeGreaterThan(0.97)
    expect(amplitudeAt(sine, 220)).toBeLessThan(1.02)

    const triangle = render('triangle', 220, 0.2)
    // Fundamental of a unit triangle: 8/π² ≈ 0.8106.
    expect(amplitudeAt(triangle, 220)).toBeGreaterThan(0.8106 * 0.97)
    expect(amplitudeAt(triangle, 220)).toBeLessThan(0.8106 * 1.03)
  })

  test('square holds only odd harmonics, at Chromiumimplied amplitudes', () => {
    const data = render('square', 200, 0.3)
    const scale = 1 / 1.179 // the measured shared normalization
    // Odd harmonics follow 4/(πn); even ones are absent.
    for (const n of [1, 3, 5, 7]) {
      const measured = amplitudeAt(data, 200 * n)
      const expected = (4 / (Math.PI * n)) * scale
      expect(Math.abs(measured - expected) / expected).toBeLessThan(0.04)
    }
    for (const n of [2, 4, 6]) {
      expect(amplitudeAt(data, 200 * n)).toBeLessThan(0.01)
    }
  })

  test('band-limiting works: a high saw has no aliased content', () => {
    // A naive sawtooth at 4 kHz folds harmonics 7, 8, 9... back to
    // 20 kHz, 16 kHz, 12 kHz — landing on INHARMONIC frequencies that a
    // band-limited oscillator leaves empty. Probing between harmonics is
    // what separates the two implementations.
    const data = render('sawtooth', 4000, 0.3)
    // Real harmonics (4, 8, 12, 16 kHz) are present...
    expect(amplitudeAt(data, 4000)).toBeGreaterThan(0.4)
    expect(amplitudeAt(data, 8000)).toBeGreaterThan(0.2)
    // ...while the gaps between them stay clean. A naive saw would have
    // aliased energy at 2, 6 and 10 kHz (from harmonics folding down).
    for (const probe of [2000, 6000, 10000, 14000]) {
      expect(amplitudeAt(data, probe)).toBeLessThan(0.01)
    }
  })

  test('frequency is exact: zero crossings count out', () => {
    const data = render('sine', 500, 0.4)
    let crossings = 0
    for (let i = 1; i < data.length; i++) {
      if (data[i - 1] < 0 && data[i] >= 0) crossings++
    }
    // 500 Hz × 0.4 s = 200 cycles. The crossing at t = 0 has no preceding
    // sample to be detected against, so 199 is the honest count.
    expect(crossings).toBeGreaterThanOrEqual(199)
    expect(crossings).toBeLessThanOrEqual(200)
  })
})
