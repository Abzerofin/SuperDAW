import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import type { AudiohostAddon } from '../audioHostSession'

/**
 * Native compressor vs the REAL Chromium DynamicsCompressorNode.
 *
 * The reference numbers below were MEASURED from Chromium (offline
 * renders in the dev page, 48 kHz, sustained 220 Hz tones, steady state
 * over the tail) — not derived from the same formulas the implementation
 * uses, so this is a genuine cross-implementation check rather than a
 * transcription agreeing with itself.
 *
 * What it pins: the static transfer curve, including Chromium's
 * surprising AUTOMATIC MAKEUP GAIN — it boosts below-threshold material
 * (+8.207 dB at threshold −24 / knee 12 / ratio 4), which is why a
 * textbook compressor would not match it. Recovering that law
 * ((1/saturate(1))^0.6 over an exponential knee whose k solves for
 * slope continuity) is what makes the native port faithful.
 *
 * What it does NOT pin: transient shape. Chromium's envelope has an
 * adaptive-release refinement this port does not reproduce, so attack
 * and release are asserted for correct SEMANTICS (direction, rough time
 * scale), not sample equality. Bounces always render through Web Audio,
 * so that residual difference lives between live native playback and the
 * exported file — documented in the backend design's parity risks.
 */

const addonPath = join(process.cwd(), 'native/audiohost/build/Release/audiohost.node')
const hasAddon = existsSync(addonPath)

const SR = 48000

describe.skipIf(!hasAddon)('native compressor vs Chromium measurements', () => {
  const require = createRequire(import.meta.url)
  const addon = require(addonPath) as AudiohostAddon
  addon.init()

  let id = 70_000
  let clock = 0

  /** Steady-state output dB of a sustained tone through the native node. */
  function steadyStateDb(
    inputDb: number,
    settings: { threshold: number; knee: number; ratio: number }
  ): number {
    const t0 = clock
    clock += 1.6

    const comp = id++
    addon.createNode(comp, 'compressor')
    addon.connect(comp, 0)
    addon.scheduleParam(comp, 'threshold', [
      { kind: 'setValue', value: settings.threshold, time: 0 }
    ])
    addon.scheduleParam(comp, 'knee', [{ kind: 'setValue', value: settings.knee, time: 0 }])
    addon.scheduleParam(comp, 'ratio', [{ kind: 'setValue', value: settings.ratio, time: 0 }])
    addon.scheduleParam(comp, 'attack', [{ kind: 'setValue', value: 0.003, time: 0 }])
    addon.scheduleParam(comp, 'release', [{ kind: 'setValue', value: 0.25, time: 0 }])

    const amp = Math.pow(10, inputDb / 20)
    const tone = new Float32Array(Math.round(1.5 * SR))
    for (let i = 0; i < tone.length; i++) {
      tone[i] = amp * Math.sin((2 * Math.PI * 220 * i) / SR)
    }
    const bufferId = `tone-${id++}`
    addon.registerBuffer(bufferId, [tone], SR)
    addon.play({ id: id++, bufferId, when: t0, destination: comp })

    const out = addon.renderOffline(t0, Math.round(1.5 * SR), SR)
    let peak = 0
    for (let i = Math.round(1.2 * SR); i < Math.round(1.5 * SR); i++) {
      peak = Math.max(peak, Math.abs(out[i * 2]))
    }
    addon.disposeNode(comp)
    addon.releaseBuffer(bufferId)
    addon.drainEnded()
    return 20 * Math.log10(peak)
  }

  // Measured from Chromium: threshold −24, knee 12, ratio 4.
  const CHROMIUM_T24_K12_R4: Array<[inputDb: number, outputDb: number]> = [
    [-40, -31.79],
    [-30, -21.79],
    [-24, -15.79],
    [-18, -10.9],
    [-12, -8.18],
    [-6, -6.5],
    [0, -4.92]
  ]

  for (const [inputDb, expected] of CHROMIUM_T24_K12_R4) {
    test(`static curve matches Chromium at ${inputDb} dBFS in`, () => {
      const measured = steadyStateDb(inputDb, { threshold: -24, knee: 12, ratio: 4 })
      expect(measured).toBeGreaterThan(expected - 0.35)
      expect(measured).toBeLessThan(expected + 0.35)
    })
  }

  // Measured from Chromium: the automatic makeup across the grid, read
  // far below threshold where the curve is pure gain.
  const CHROMIUM_MAKEUP: Array<[knee: number, ratio: number, makeupDb: number]> = [
    [0, 2, 7.2],
    [0, 4, 10.8],
    [0, 8, 12.6],
    [0, 12, 13.2],
    [0, 20, 13.68],
    [12, 2, 5.309],
    [12, 4, 8.207],
    [12, 8, 9.857],
    [12, 20, 11.078],
    [30, 4, 2.394],
    [30, 12, 3.66]
  ]

  for (const [knee, ratio, makeupDb] of CHROMIUM_MAKEUP) {
    test(`automatic makeup matches Chromium (knee ${knee}, ratio ${ratio})`, () => {
      const measured = steadyStateDb(-60, { threshold: -24, knee, ratio }) - -60
      expect(measured).toBeGreaterThan(makeupDb - 0.15)
      expect(measured).toBeLessThan(makeupDb + 0.15)
    })
  }

  // Measured from Chromium: threshold sweep at knee 12, ratio 4.
  const CHROMIUM_BY_THRESHOLD: Array<[threshold: number, makeupDb: number]> = [
    [-40, 15.406],
    [-30, 10.907],
    [-12, 2.807],
    [-6, 0.73]
  ]

  for (const [threshold, makeupDb] of CHROMIUM_BY_THRESHOLD) {
    test(`automatic makeup matches Chromium (threshold ${threshold})`, () => {
      const measured = steadyStateDb(-80, { threshold, knee: 12, ratio: 4 }) - -80
      expect(measured).toBeGreaterThan(makeupDb - 0.15)
      expect(measured).toBeLessThan(makeupDb + 0.15)
    })
  }

  test('attack and release move the gain in the right direction, on the right scale', () => {
    const t0 = clock
    clock += 3

    const comp = id++
    addon.createNode(comp, 'compressor')
    addon.connect(comp, 0)
    addon.scheduleParam(comp, 'threshold', [{ kind: 'setValue', value: -24, time: 0 }])
    addon.scheduleParam(comp, 'knee', [{ kind: 'setValue', value: 0, time: 0 }])
    addon.scheduleParam(comp, 'ratio', [{ kind: 'setValue', value: 8, time: 0 }])
    addon.scheduleParam(comp, 'attack', [{ kind: 'setValue', value: 0.05, time: 0 }])
    addon.scheduleParam(comp, 'release', [{ kind: 'setValue', value: 0.3, time: 0 }])

    // Loud for 0.5 s, then silence — watch the gain clamp down and recover.
    const tone = new Float32Array(Math.round(1.5 * SR))
    for (let i = 0; i < Math.round(0.5 * SR); i++) {
      tone[i] = 0.9 * Math.sin((2 * Math.PI * 220 * i) / SR)
    }
    // A quiet probe after the loud burst reveals the recovering gain.
    for (let i = Math.round(0.5 * SR); i < tone.length; i++) {
      tone[i] = 0.002 * Math.sin((2 * Math.PI * 220 * i) / SR)
    }
    const bufferId = `env-${id++}`
    addon.registerBuffer(bufferId, [tone], SR)
    addon.play({ id: id++, bufferId, when: t0, destination: comp })
    const out = addon.renderOffline(t0, Math.round(1.5 * SR), SR)

    const peakOver = (fromSec: number, toSec: number): number => {
      let peak = 0
      for (let i = Math.round(fromSec * SR); i < Math.round(toSec * SR); i++) {
        peak = Math.max(peak, Math.abs(out[i * 2]))
      }
      return peak
    }
    // Attack: the first milliseconds pass louder than the settled level.
    const onset = peakOver(0.006, 0.02)
    const settled = peakOver(0.3, 0.5)
    expect(onset).toBeGreaterThan(settled)
    // Release: the quiet probe is still ducked right after the burst and
    // recovers toward full makeup a release-constant later.
    const justAfter = peakOver(0.52, 0.56)
    const later = peakOver(1.2, 1.45)
    expect(later).toBeGreaterThan(justAfter * 1.5)

    addon.disposeNode(comp)
    addon.releaseBuffer(bufferId)
    addon.drainEnded()
  })
})
