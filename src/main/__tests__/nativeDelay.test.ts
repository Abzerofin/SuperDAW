import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import type { AudiohostAddon } from '../audioHostSession'

/**
 * Native delay + feedback-cycle verification: an impulse through
 * click → delay(0.25 s) → master with delay → gain(0.5) → delay feedback
 * must produce the textbook echo train — pulses at exactly 0.25 s
 * spacing, each half the last — which exercises the ring read/write
 * split, the in-cycle one-block rule, and the feedback subtree rendering
 * that only the ring pass reaches.
 */

const addonPath = join(process.cwd(), 'native/audiohost/build/Release/audiohost.node')
const hasAddon = existsSync(addonPath)

const SR = 48000

describe.skipIf(!hasAddon)('native delay feedback loop', () => {
  test('impulse produces the halving echo train at exact spacing', () => {
    const require = createRequire(import.meta.url)
    const addon = require(addonPath) as AudiohostAddon
    addon.init()

    let id = 90_000
    const delay = id++
    addon.createNode(delay, 'delay', { maxDelay: 2 })
    addon.scheduleParam(delay, 'delayTime', [{ kind: 'setValue', value: 0.25, time: 0 }])
    addon.connect(delay, 0)
    const feedback = id++
    addon.createNode(feedback, 'gain')
    addon.scheduleParam(feedback, 'gain', [{ kind: 'setValue', value: 0.5, time: 0 }])
    addon.connect(delay, feedback)
    addon.connect(feedback, delay)

    const click = new Float32Array(64)
    click[0] = 1
    addon.registerBuffer('click', [click], SR)
    addon.play({ id: id++, bufferId: 'click', when: 0.1, destination: delay })

    const out = addon.renderOffline(0, Math.round(1.1 * SR), SR)

    const peakAround = (sec: number): { amp: number; frame: number } => {
      const center = Math.round(sec * SR)
      let amp = 0
      let frame = center
      for (let i = center - 256; i <= center + 256; i++) {
        const v = Math.abs(out[i * 2])
        if (v > amp) {
          amp = v
          frame = i
        }
      }
      return { amp, frame }
    }

    // Nothing at the play time itself — the dry path does not exist here.
    expect(peakAround(0.1).amp).toBeLessThan(1e-6)

    const first = peakAround(0.35)
    const second = peakAround(0.6)
    const third = peakAround(0.85)
    expect(first.amp).toBeCloseTo(1, 2)
    expect(second.amp).toBeCloseTo(0.5, 2)
    expect(third.amp).toBeCloseTo(0.25, 2)
    // Sample-exact spacing: 0.25 s is an integer frame count at 48 kHz.
    expect(first.frame).toBe(Math.round(0.35 * SR))
    expect(second.frame).toBe(Math.round(0.6 * SR))
    expect(third.frame).toBe(Math.round(0.85 * SR))
  })
})
