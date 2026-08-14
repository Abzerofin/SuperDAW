import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import type { AudiohostAddon } from '../audioHostSession'

/**
 * The analog synth voice running on the NATIVE engine: scheduled-source
 * lifecycle (an oscillator audible only inside its note window, then
 * reporting ended), the ADSR envelope, and the detuned-pair tone.
 *
 * This is the capability the instruments needed beyond DSP — buffer
 * voices already had start/stop/ended; generated ones did not.
 */

const addonPath = join(process.cwd(), 'native/audiohost/build/Release/audiohost.node')
const hasAddon = existsSync(addonPath)

const SR = 48000

describe.skipIf(!hasAddon)('native scheduled sources + synth voice', () => {
  const require = createRequire(import.meta.url)
  const addon = require(addonPath) as AudiohostAddon
  addon.init()
  let id = 80_000
  let clock = 900

  /** Peak amplitude over a window of the rendered stereo buffer. */
  function peak(out: Float32Array, fromSec: number, toSec: number, base: number): number {
    let max = 0
    const from = Math.round((fromSec - base) * SR)
    const to = Math.round((toSec - base) * SR)
    for (let i = Math.max(0, from); i < to; i++) max = Math.max(max, Math.abs(out[i * 2]))
    return max
  }

  test('a scheduled oscillator sounds only inside its window, then ends', () => {
    const t0 = clock
    clock += 3

    const osc = id++
    addon.createNode(osc, 'oscillator', { type: 'sine' })
    addon.scheduleParam(osc, 'frequency', [{ kind: 'setValue', value: 440, time: 0 }])
    addon.connect(osc, 0)
    const voice = id++
    // Sounds from t0+0.2 until t0+0.5.
    addon.scheduleSource(voice, osc, t0 + 0.2, t0 + 0.5)

    const out = addon.renderOffline(t0, Math.round(0.8 * SR), SR)
    expect(peak(out, t0, t0 + 0.19, t0)).toBeLessThan(1e-6) // silent before
    expect(peak(out, t0 + 0.25, t0 + 0.45, t0)).toBeGreaterThan(0.9) // audible
    expect(peak(out, t0 + 0.55, t0 + 0.8, t0)).toBeLessThan(1e-6) // silent after
    expect(addon.drainEnded()).toContain(voice)

    addon.disposeNode(osc)
  })

  test('an open-ended source runs until stopVoice ends it', () => {
    const t0 = clock
    clock += 3

    const osc = id++
    addon.createNode(osc, 'oscillator', { type: 'sine' })
    addon.scheduleParam(osc, 'frequency', [{ kind: 'setValue', value: 300, time: 0 }])
    addon.connect(osc, 0)
    const voice = id++
    addon.scheduleSource(voice, osc, t0) // no stop: a held key

    let out = addon.renderOffline(t0, Math.round(0.3 * SR), SR)
    expect(peak(out, t0 + 0.1, t0 + 0.3, t0)).toBeGreaterThan(0.9)
    expect(addon.drainEnded()).not.toContain(voice)

    // Release it partway through the next render.
    addon.stopVoice(voice, t0 + 0.4)
    out = addon.renderOffline(t0 + 0.3, Math.round(0.3 * SR), SR)
    expect(peak(out, t0 + 0.3, t0 + 0.39, t0 + 0.3)).toBeGreaterThan(0.9)
    expect(peak(out, t0 + 0.45, t0 + 0.6, t0 + 0.3)).toBeLessThan(1e-6)
    expect(addon.drainEnded()).toContain(voice)

    addon.disposeNode(osc)
  })

  /**
   * One synth voice as buildSynthVoice constructs it, expressed directly
   * against the addon. `detunes` is a parameter because a DETUNED PAIR
   * beats (±8 cents at 440 Hz ≈ 4 Hz), which would confound any
   * peak-over-window reading of the envelope — so the ADSR is measured on
   * a single oscillator and the beating is its own test.
   */
  function buildVoice(
    detunes: number[],
    opts: { attack: number; peakLevel: number; start: number; noteEnd: number; release: number }
  ): { voices: number[]; nodes: number[] } {
    const { attack, peakLevel, start, noteEnd, release } = opts
    const freq = 440
    const filter = id++
    addon.createNode(filter, 'biquad', { type: 'lowpass' })
    addon.scheduleParam(filter, 'frequency', [{ kind: 'setValue', value: 8000, time: 0 }])
    addon.scheduleParam(filter, 'Q', [{ kind: 'setValue', value: 0.7, time: 0 }])
    const env = id++
    addon.createNode(env, 'gain')
    addon.scheduleParam(env, 'gain', [
      { kind: 'setValue', value: 0, time: start },
      { kind: 'linearRamp', value: peakLevel, endTime: start + attack },
      { kind: 'linearRamp', value: peakLevel * 0.7, endTime: start + attack + 0.1 },
      { kind: 'setValue', value: peakLevel * 0.7, time: noteEnd },
      { kind: 'linearRamp', value: 0.0001, endTime: noteEnd + release }
    ])
    addon.connect(filter, env)
    addon.connect(env, 0)
    const voices: number[] = []
    const nodes = [filter, env]
    for (const detune of detunes) {
      const osc = id++
      addon.createNode(osc, 'oscillator', { type: 'sawtooth' })
      addon.scheduleParam(osc, 'frequency', [{ kind: 'setValue', value: freq, time: 0 }])
      addon.scheduleParam(osc, 'detune', [{ kind: 'setValue', value: detune, time: 0 }])
      addon.connect(osc, filter)
      const voice = id++
      addon.scheduleSource(voice, osc, start, noteEnd + release + 0.01)
      voices.push(voice)
      nodes.push(osc)
    }
    return { voices, nodes }
  }

  test('the synth voice ADSR: attack rises, decays to sustain, release empties', () => {
    const t0 = clock
    clock += 4

    const attack = 0.1
    const peakLevel = 0.22
    const start = t0 + 0.05
    const noteEnd = start + 0.5
    const release = 0.2

    // A SINGLE oscillator: no detune beating to confound the envelope.
    const { voices, nodes } = buildVoice([0], {
      attack,
      peakLevel,
      start,
      noteEnd,
      release
    })
    const out = addon.renderOffline(t0, Math.round(1.2 * SR), SR)

    // Silent before the note.
    expect(peak(out, t0, start - 0.01, t0)).toBeLessThan(1e-6)
    // The attack ramp rises: early in it, quieter than at its end.
    const early = peak(out, start + 0.01, start + 0.03, t0)
    const atPeak = peak(out, start + attack - 0.02, start + attack + 0.01, t0)
    expect(atPeak).toBeGreaterThan(early * 2)
    // Sustain sits below the peak (decay to 0.7).
    const sustain = peak(out, start + 0.3, noteEnd - 0.01, t0)
    expect(sustain).toBeLessThan(atPeak)
    expect(sustain).toBeGreaterThan(atPeak * 0.5)
    // The release empties it.
    expect(peak(out, noteEnd + release + 0.05, t0 + 1.2, t0)).toBeLessThan(1e-4)
    // The oscillator reported ended.
    expect(addon.drainEnded()).toContain(voices[0])
    for (const n of nodes) addon.disposeNode(n)
  })

  test('the detuned pair beats, and holds its 440 Hz fundamental', () => {
    const t0 = clock
    clock += 4

    const start = t0 + 0.05
    const noteEnd = start + 1.0
    // Flat envelope (instant attack, full sustain) so only the detuning
    // shapes the amplitude.
    const { voices, nodes } = buildVoice([-8, 8], {
      attack: 0.001,
      peakLevel: 0.22,
      start,
      noteEnd,
      release: 0.05
    })
    const out = addon.renderOffline(t0, Math.round(1.2 * SR), SR)

    // ±8 cents at 440 Hz puts the fundamentals ~4 Hz apart, so the sum
    // beats. The depth is modest rather than a null: each harmonic n
    // beats at n·Δf, so they never all cancel at once — which is exactly
    // why a detuned SAW pair thickens instead of tremoloing.
    const env: number[] = []
    const win = Math.round(0.02 * SR)
    for (let s = Math.round((start + 0.1 - t0) * SR); s + win < Math.round((noteEnd - 0.05 - t0) * SR); s += win) {
      let p = 0
      for (let i = s; i < s + win; i++) p = Math.max(p, Math.abs(out[i * 2]))
      env.push(p)
    }
    const maxEnv = Math.max(...env)
    const minEnv = Math.min(...env)
    expect(maxEnv).toBeGreaterThan(0) // the pair is audible at all
    expect(minEnv).toBeLessThan(maxEnv * 0.95) // and genuinely modulating

    // The energy still sits at 440 Hz and its harmonics. (Zero crossings
    // would be the wrong instrument here: two summed saws each contribute
    // a discontinuity per cycle, so they read ~2× the fundamental.)
    const from = Math.round((start + 0.1 - t0) * SR)
    const to = Math.round((noteEnd - 0.05 - t0) * SR)
    const amplitudeAt = (freq: number): number => {
      const w = (2 * Math.PI * freq) / SR
      let re = 0
      let im = 0
      for (let i = from; i < to; i++) {
        re += out[i * 2] * Math.cos(w * i)
        im += out[i * 2] * Math.sin(w * i)
      }
      return (2 * Math.hypot(re, im)) / (to - from)
    }
    const fundamental = amplitudeAt(440)
    expect(fundamental).toBeGreaterThan(0.02)
    // ...and not at an inharmonic frequency (a saw's partials are 440·n).
    expect(amplitudeAt(660)).toBeLessThan(fundamental * 0.2)

    expect(addon.drainEnded().length).toBeGreaterThanOrEqual(voices.length)
    for (const n of nodes) addon.disposeNode(n)
  })
})
