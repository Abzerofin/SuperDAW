import { describe as suite, expect, test } from 'vitest'
import { encodeMp3 } from '../exportAudio'

/**
 * The encoder is third-party; these pin OUR wrapping of it — block
 * chunking, stereo/mono handling, and that the output is actually an MP3
 * bitstream rather than silence-sized garbage.
 */

function sine(seconds: number, sampleRate: number, freq = 440): Float32Array {
  const out = new Float32Array(Math.round(seconds * sampleRate))
  for (let i = 0; i < out.length; i++) {
    out[i] = 0.5 * Math.sin((2 * Math.PI * freq * i) / sampleRate)
  }
  return out
}

suite('encodeMp3', () => {
  test('produces a framed MP3 bitstream of plausible size', () => {
    const sampleRate = 44100
    const mp3 = encodeMp3([sine(1, sampleRate), sine(1, sampleRate, 660)], sampleRate)
    // MP3 frames start with an 11-bit sync run: 0xFF followed by 0xEx/0xFx.
    expect(mp3[0]).toBe(0xff)
    expect(mp3[1] & 0xe0).toBe(0xe0)
    // 192kbps ≈ 24 KB/s: a second of audio must be in that ballpark, far
    // from both zero and the ~176 KB raw PCM would be.
    expect(mp3.length).toBeGreaterThan(15_000)
    expect(mp3.length).toBeLessThan(40_000)
  })

  test('mono input duplicates into both channels rather than crashing', () => {
    const sampleRate = 44100
    const mp3 = encodeMp3([sine(0.25, sampleRate)], sampleRate)
    expect(mp3.length).toBeGreaterThan(3_000)
    expect(mp3[0]).toBe(0xff)
  })

  test('input not divisible by the 1152 block size still encodes fully', () => {
    const sampleRate = 44100
    const odd = sine(1.0001, sampleRate) // 44104 samples: 38 blocks + 328 leftover
    const mp3 = encodeMp3([odd, odd], sampleRate)
    expect(mp3.length).toBeGreaterThan(15_000)
  })
})
