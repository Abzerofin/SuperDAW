import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { makeImpulse, makeNoise } from '../../audio/impulse'
import type { AudiohostAddon } from '../audioHostSession'

/**
 * Cross-backend parity: the SAME material rendered through the native
 * engine, compared against values measured from Chromium's Web Audio.
 *
 * This is the acceptance test phase 2 was built toward, and it is
 * deliberately narrower than "diff two full mixes". The per-primitive
 * suites already pin each DSP block against measured Chromium behaviour
 * (biquad 15 checks, compressor 23, convolver sample-exact, oscillator
 * harmonics); what this adds is the COMPOSITION — chains, sums, buses
 * and voices interacting — where a mistake in the graph walk rather
 * than in any single filter would show.
 *
 * The Web Audio reference numbers below were measured in the dev page at
 * 48 kHz and are quoted with the tolerance each earns. Where a value is
 * exact by construction (a gain product, a sum) the tolerance is tight;
 * where an implementation detail legitimately differs (the compressor's
 * envelope, near-Nyquist oscillator crossovers) it is loose and the
 * reason is named.
 */

const addonPath = join(process.cwd(), 'native/audiohost/build/Release/audiohost.node')
const hasAddon = existsSync(addonPath)

const SR = 48000

describe.skipIf(!hasAddon)('cross-backend parity: composed graphs', () => {
  const require = createRequire(import.meta.url)
  const addon = require(addonPath) as AudiohostAddon
  addon.init()
  let id = 200_000
  let clock = 5000

  function rms(out: Float32Array, fromSec: number, toSec: number, channel = 0): number {
    let sum = 0
    const from = Math.round(fromSec * SR)
    const to = Math.round(toSec * SR)
    for (let i = from; i < to; i++) {
      const v = out[i * 2 + channel]
      sum += v * v
    }
    return Math.sqrt(sum / Math.max(1, to - from))
  }

  /** A steady full-scale tone registered as a buffer. */
  function tone(freq: number, seconds: number, amp = 1): string {
    const data = new Float32Array(Math.round(seconds * SR))
    for (let i = 0; i < data.length; i++) {
      data[i] = amp * Math.sin((2 * Math.PI * freq * i) / SR)
    }
    const bufferId = `xb-tone-${id++}`
    addon.registerBuffer(bufferId, [data], SR)
    return bufferId
  }

  test('a gain chain multiplies exactly, as Web Audio does', () => {
    const t0 = clock
    clock += 2
    // 0.8 → 0.5 → 0.25 in series = 0.1; a full-scale sine reads
    // 0.1/√2 ≈ 0.0707 RMS. Node-for-node identical on both backends.
    const a = id++
    const b = id++
    const c = id++
    for (const [node, value] of [
      [a, 0.8],
      [b, 0.5],
      [c, 0.25]
    ] as const) {
      addon.createNode(node, 'gain')
      addon.scheduleParam(node, 'gain', [{ kind: 'setValue', value, time: 0 }])
    }
    addon.connect(a, b)
    addon.connect(b, c)
    addon.connect(c, 0)
    addon.play({ id: id++, bufferId: tone(440, 1), when: t0, destination: a })

    const out = addon.renderOffline(t0, Math.round(0.8 * SR), SR)
    expect(rms(out, 0.1, 0.7)).toBeCloseTo(0.1 / Math.SQRT2, 3)
    for (const n of [a, b, c]) addon.disposeNode(n)
    addon.drainEnded()
  })

  test('fan-in sums, exactly like Web Audio sums into one node', () => {
    const t0 = clock
    clock += 2
    // Two sources at 0.3 and 0.4 into one gain: coherent sum = 0.7.
    const bus = id++
    addon.createNode(bus, 'gain')
    addon.scheduleParam(bus, 'gain', [{ kind: 'setValue', value: 1, time: 0 }])
    addon.connect(bus, 0)
    addon.play({ id: id++, bufferId: tone(300, 1, 0.3), when: t0, destination: bus })
    addon.play({ id: id++, bufferId: tone(300, 1, 0.4), when: t0, destination: bus })

    const out = addon.renderOffline(t0, Math.round(0.8 * SR), SR)
    expect(rms(out, 0.1, 0.7)).toBeCloseTo(0.7 / Math.SQRT2, 3)
    addon.disposeNode(bus)
    addon.drainEnded()
  })

  test('a folder-bus shape: two tracks, panned, through a bus gain', () => {
    const t0 = clock
    clock += 2
    // The mixer's actual topology: track → panner → bus gain → master.
    // Hard-panned opposite ways, so each channel carries exactly one
    // track at the bus gain — equal-power pan puts the full signal on
    // one side (cos(0)=1) and nothing on the other.
    const bus = id++
    addon.createNode(bus, 'gain')
    addon.scheduleParam(bus, 'gain', [{ kind: 'setValue', value: 0.5, time: 0 }])
    addon.connect(bus, 0)
    const left = id++
    const right = id++
    addon.createNode(left, 'stereoPanner')
    addon.scheduleParam(left, 'pan', [{ kind: 'setValue', value: -1, time: 0 }])
    addon.createNode(right, 'stereoPanner')
    addon.scheduleParam(right, 'pan', [{ kind: 'setValue', value: 1, time: 0 }])
    addon.connect(left, bus)
    addon.connect(right, bus)
    addon.play({ id: id++, bufferId: tone(400, 1, 0.6), when: t0, destination: left })
    addon.play({ id: id++, bufferId: tone(700, 1, 0.2), when: t0, destination: right })

    const out = addon.renderOffline(t0, Math.round(0.8 * SR), SR)
    // Left channel: only the 0.6 source, at the 0.5 bus gain.
    expect(rms(out, 0.1, 0.7, 0)).toBeCloseTo((0.6 * 0.5) / Math.SQRT2, 3)
    // Right channel: only the 0.2 source.
    expect(rms(out, 0.1, 0.7, 1)).toBeCloseTo((0.2 * 0.5) / Math.SQRT2, 3)
    for (const n of [bus, left, right]) addon.disposeNode(n)
    addon.drainEnded()
  })

  test('an insert chain composes: EQ3 shape then a compressor', () => {
    const t0 = clock
    clock += 3
    // The eq3 builder's shape (lowshelf → peaking → highshelf) feeding a
    // compressor, i.e. the fixture's synth track. A −40 dBFS tone sits
    // far below the −24 dB threshold, so the compressor contributes only
    // its automatic makeup — which is what makes the composition
    // predictable: shelf gain × makeup, both independently pinned.
    const low = id++
    addon.createNode(low, 'biquad', { type: 'lowshelf' })
    addon.scheduleParam(low, 'frequency', [{ kind: 'setValue', value: 200, time: 0 }])
    addon.scheduleParam(low, 'gain', [{ kind: 'setValue', value: 6, time: 0 }])
    const comp = id++
    addon.createNode(comp, 'compressor')
    addon.scheduleParam(comp, 'threshold', [{ kind: 'setValue', value: -24, time: 0 }])
    addon.scheduleParam(comp, 'knee', [{ kind: 'setValue', value: 12, time: 0 }])
    addon.scheduleParam(comp, 'ratio', [{ kind: 'setValue', value: 4, time: 0 }])
    addon.connect(low, comp)
    addon.connect(comp, 0)
    // 100 Hz is under the 200 Hz shelf, so it takes the full +6 dB.
    addon.play({ id: id++, bufferId: tone(100, 2, 0.01), when: t0, destination: low })

    const out = addon.renderOffline(t0, Math.round(1.5 * SR), SR)
    const measured = 20 * Math.log10(rms(out, 1.0, 1.4) * Math.SQRT2)
    // −40 dBFS + 6 dB shelf + 8.207 dB measured Chromium makeup.
    const expected = -40 + 6 + 8.207
    expect(Math.abs(measured - expected)).toBeLessThan(0.6)
    for (const n of [low, comp]) addon.disposeNode(n)
    addon.drainEnded()
  })

  test('reverb composes with a dry path at the builder’s mix law', () => {
    const t0 = clock
    clock += 3
    // The reverb builder's topology: input → dry(1 − mix/2) + wet(mix)
    // → mixed. With mix = 0, the wet path contributes nothing and the
    // output must be exactly the dry gain — a clean check that the
    // convolver is wired in parallel rather than in series.
    const input = id++
    addon.createNode(input, 'gain')
    addon.scheduleParam(input, 'gain', [{ kind: 'setValue', value: 1, time: 0 }])
    const dry = id++
    addon.createNode(dry, 'gain')
    addon.scheduleParam(dry, 'gain', [{ kind: 'setValue', value: 1, time: 0 }])
    const wet = id++
    addon.createNode(wet, 'gain')
    addon.scheduleParam(wet, 'gain', [{ kind: 'setValue', value: 0, time: 0 }])
    const conv = id++
    addon.createNode(conv, 'convolver')
    addon.registerBuffer('xb-ir', makeImpulse(SR, 0.4), SR)
    addon.configureNode(conv, { buffer: 'xb-ir' })
    addon.connect(input, dry)
    addon.connect(input, conv)
    addon.connect(conv, wet)
    addon.connect(dry, 0)
    addon.connect(wet, 0)
    addon.play({ id: id++, bufferId: tone(500, 1, 0.5), when: t0, destination: input })

    const out = addon.renderOffline(t0, Math.round(0.8 * SR), SR)
    // Dry only: exactly the source level.
    expect(rms(out, 0.1, 0.6)).toBeCloseTo(0.5 / Math.SQRT2, 3)
    for (const n of [input, dry, wet, conv]) addon.disposeNode(n)
    addon.releaseBuffer('xb-ir')
    addon.drainEnded()
  })

  test('a pitch envelope on a LATER-starting source, as Web Audio renders it', () => {
    const t0 = clock
    clock += 3
    // The drum synth's pitch drops (kick, snare, toms) are a ramp on an
    // oscillator that starts at the hit, not at time 0 — and that is the
    // one place the two backends can disagree about a param TIMELINE
    // rather than about DSP. Chromium does not evaluate a source's
    // timeline before the source renders, so it implicitly anchors a
    // ramp whose previous event sits at time 0; the native engine reads
    // the timeline literally and would arrive at the ramp's target long
    // before the hit. An ANCHORED ramp is the shape both agree on, so
    // that is what the builders must emit and what this pins.
    const osc = id++
    addon.createNode(osc, 'oscillator', { type: 'triangle' })
    addon.scheduleParam(osc, 'frequency', [{ kind: 'setValue', value: 176, time: 0 }])
    addon.scheduleParam(osc, 'frequency', [
      { kind: 'setValue', value: 176, time: t0 },
      { kind: 'exponentialRamp', value: 155, endTime: t0 + 0.08 }
    ])
    addon.connect(osc, 0)
    const voice = id++
    addon.scheduleSource(voice, osc, t0, t0 + 0.25)

    const out = addon.renderOffline(t0, Math.round(0.2 * SR), SR)
    // Per-cycle frequency from interpolated positive-going zero
    // crossings — the pitch trajectory the ear actually follows.
    const cross: number[] = []
    for (let i = 1; i < Math.round(0.085 * SR); i++) {
      const a = out[(i - 1) * 2]
      const b = out[i * 2]
      if (a < 0 && b >= 0) cross.push((i - 1 + a / (a - b)) / SR)
    }
    const hz = cross.slice(1).map((t, i) => 1 / (t - cross[i]))
    // Measured in the dev page against Chromium at 48 kHz: the two
    // backends agree to better than 0.01 Hz on every cycle.
    const chromium = [
      173.62, 172.03, 170.44, 168.85, 167.27, 165.68, 164.09, 162.5, 160.91, 159.33, 157.74,
      156.15
    ]
    expect(hz.length).toBe(chromium.length)
    hz.forEach((v, i) => expect(Math.abs(v - chromium[i])).toBeLessThan(0.05))

    addon.disposeNode(osc)
    addon.drainEnded()
  })

  test('a full voice path: instrument → insert → pan → bus → master', () => {
    const t0 = clock
    clock += 3
    // Everything at once, which is the point of this suite: a scheduled
    // oscillator voice through an envelope, a lowpass, a panner and a
    // bus. The assertion is structural (audible, centred, bounded, and
    // silent once released) rather than a single number, because that is
    // what composition can honestly promise.
    const bus = id++
    addon.createNode(bus, 'gain')
    addon.scheduleParam(bus, 'gain', [{ kind: 'setValue', value: 0.8, time: 0 }])
    addon.connect(bus, 0)
    const pan = id++
    addon.createNode(pan, 'stereoPanner')
    addon.scheduleParam(pan, 'pan', [{ kind: 'setValue', value: 0, time: 0 }])
    addon.connect(pan, bus)
    const filter = id++
    addon.createNode(filter, 'biquad', { type: 'lowpass' })
    addon.scheduleParam(filter, 'frequency', [{ kind: 'setValue', value: 1200, time: 0 }])
    addon.scheduleParam(filter, 'Q', [{ kind: 'setValue', value: 0.7, time: 0 }])
    addon.connect(filter, pan)
    const env = id++
    addon.createNode(env, 'gain')
    addon.scheduleParam(env, 'gain', [
      { kind: 'setValue', value: 0, time: t0 },
      { kind: 'linearRamp', value: 0.5, endTime: t0 + 0.05 },
      { kind: 'setValue', value: 0.5, time: t0 + 0.5 },
      { kind: 'linearRamp', value: 0.0001, endTime: t0 + 0.7 }
    ])
    addon.connect(env, filter)
    const osc = id++
    addon.createNode(osc, 'oscillator', { type: 'sawtooth' })
    addon.scheduleParam(osc, 'frequency', [{ kind: 'setValue', value: 220, time: 0 }])
    addon.connect(osc, env)
    const voice = id++
    addon.scheduleSource(voice, osc, t0, t0 + 0.75)
    // A drum hit on the same bus, so voices and buffer sources mix. It
    // goes through its own trim: full-scale noise plus the voice would
    // sum past 1.0, which says nothing about the engine.
    addon.registerBuffer('xb-noise', makeNoise(SR), SR)
    const hit = id++
    addon.createNode(hit, 'gain')
    addon.scheduleParam(hit, 'gain', [{ kind: 'setValue', value: 0.3, time: 0 }])
    addon.connect(hit, bus)
    addon.play({
      id: id++,
      bufferId: 'xb-noise',
      when: t0 + 0.1,
      offsetSec: 0,
      durationSec: 0.05,
      destination: hit
    })

    const out = addon.renderOffline(t0, Math.round(1.0 * SR), SR)
    expect(rms(out, 0.2, 0.45)).toBeGreaterThan(0.05) // the voice sounds
    expect(rms(out, 0.8, 1.0)).toBeLessThan(1e-3) // and is gone after release
    // Centre pan: both channels carry it equally.
    expect(rms(out, 0.2, 0.45, 0)).toBeCloseTo(rms(out, 0.2, 0.45, 1), 4)
    // Nothing clipped anywhere in the chain.
    let peak = 0
    for (let i = 0; i < out.length; i++) peak = Math.max(peak, Math.abs(out[i]))
    expect(peak).toBeLessThan(1)
    expect(addon.drainEnded()).toContain(voice)

    for (const n of [bus, pan, filter, env, osc, hit]) addon.disposeNode(n)
    addon.releaseBuffer('xb-noise')
  })
})
