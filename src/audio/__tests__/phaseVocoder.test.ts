import { expect, suite, test } from 'vitest'
import { stretchChannels } from '../phaseVocoder'

const RATE = 48000

function sine(freq: number, seconds: number, amp = 0.8): Float32Array {
  const out = new Float32Array(Math.round(seconds * RATE))
  for (let i = 0; i < out.length; i++) out[i] = amp * Math.sin((2 * Math.PI * freq * i) / RATE)
  return out
}

/**
 * Dominant frequency via zero crossings over the middle of the signal —
 * cycle-anchored (first to last upward crossing), so the window bounds
 * never quantize the reading.
 */
function dominantFreq(data: Float32Array): number {
  const start = Math.round(data.length * 0.25)
  const end = Math.round(data.length * 0.75)
  let first = -1
  let last = -1
  let crossings = 0
  for (let i = start + 1; i < end; i++) {
    if (data[i - 1] < 0 && data[i] >= 0) {
      if (first < 0) first = i
      last = i
      crossings++
    }
  }
  return crossings > 1 ? (crossings - 1) / ((last - first) / RATE) : 0
}

function rms(data: Float32Array, from = 0.25, to = 0.75): number {
  const start = Math.round(data.length * from)
  const end = Math.round(data.length * to)
  let sum = 0
  for (let i = start; i < end; i++) sum += data[i] * data[i]
  return Math.sqrt(sum / (end - start))
}

suite('stretchChannels', () => {
  test('stretching longer keeps the pitch (the whole point)', () => {
    const [out] = stretchChannels([sine(440, 1)], 1.5)
    expect(out.length).toBe(Math.round(1.5 * RATE))
    // Pitch must NOT move: tape-style would read 440/1.5 ≈ 293 Hz here.
    expect(dominantFreq(out)).toBeGreaterThan(437)
    expect(dominantFreq(out)).toBeLessThan(443)
  })

  test('compressing shorter keeps the pitch too', () => {
    const [out] = stretchChannels([sine(440, 1)], 0.5)
    expect(out.length).toBe(Math.round(0.5 * RATE))
    expect(dominantFreq(out)).toBeGreaterThan(437)
    expect(dominantFreq(out)).toBeLessThan(443)
  })

  test('level survives within a dB', () => {
    const source = sine(330, 1)
    const [out] = stretchChannels([source], 1.25)
    const ratio = rms(out) / rms(source)
    expect(ratio).toBeGreaterThan(0.89)
    expect(ratio).toBeLessThan(1.12)
  })

  test('factor 1 is a pass-through copy', () => {
    const source = sine(440, 0.25)
    const [out] = stretchChannels([source], 1)
    expect(out).not.toBe(source)
    expect(out.length).toBe(source.length)
    expect(out[1000]).toBeCloseTo(source[1000], 6)
  })

  test('every channel stretches; channel count is preserved', () => {
    const out = stretchChannels([sine(220, 0.5), sine(440, 0.5)], 2)
    expect(out).toHaveLength(2)
    expect(dominantFreq(out[0])).toBeGreaterThan(217)
    expect(dominantFreq(out[0])).toBeLessThan(223)
    expect(dominantFreq(out[1])).toBeGreaterThan(437)
    expect(dominantFreq(out[1])).toBeLessThan(443)
  })

  test('material too short for the STFT still stretches (linear floor)', () => {
    const [out] = stretchChannels([sine(440, 0.05)], 2)
    expect(out.length).toBe(Math.round(0.1 * RATE))
  })

  test('deterministic: identical inputs produce identical outputs', () => {
    const [a] = stretchChannels([sine(440, 0.5)], 1.3)
    const [b] = stretchChannels([sine(440, 0.5)], 1.3)
    expect(a).toEqual(b)
  })
})
