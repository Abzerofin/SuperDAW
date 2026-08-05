import { describe as suite, expect, test } from 'vitest'
import { encodeWavPcm16 } from '../wav'

suite('encodeWavPcm16', () => {
  test('writes a valid stereo header and interleaved samples', () => {
    const left = new Float32Array([0, 0.5, -0.5, 1])
    const right = new Float32Array([1, -1, 0.25, -0.25])
    const bytes = encodeWavPcm16([left, right], 48000)
    const view = new DataView(bytes.buffer)

    const ascii = (offset: number, length: number): string =>
      String.fromCharCode(...bytes.subarray(offset, offset + length))
    expect(ascii(0, 4)).toBe('RIFF')
    expect(ascii(8, 4)).toBe('WAVE')
    expect(view.getUint16(22, true)).toBe(2) // channels
    expect(view.getUint32(24, true)).toBe(48000)
    expect(view.getUint32(40, true)).toBe(4 * 2 * 2) // frames * channels * 2 bytes

    // Interleaved L/R; clipping clamps to full-scale
    expect(view.getInt16(44, true)).toBe(0) // L[0]
    expect(view.getInt16(46, true)).toBe(0x7fff) // R[0] = 1.0
    expect(view.getInt16(48, true)).toBe(Math.round(0.5 * 0x7fff)) // L[1]
    expect(view.getInt16(50, true)).toBe(-0x8000) // R[1] = -1.0
  })

  test('mono round-trips through sample values', () => {
    const data = new Float32Array([0.1, -0.9])
    const bytes = encodeWavPcm16([data], 44100)
    const view = new DataView(bytes.buffer)
    expect(view.getUint16(22, true)).toBe(1)
    expect(view.getInt16(44, true)).toBe(Math.round(0.1 * 0x7fff))
    expect(view.getInt16(46, true)).toBe(Math.round(-0.9 * 0x8000))
  })
})
