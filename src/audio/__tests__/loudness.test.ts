import { expect, suite, test } from 'vitest'
import { LiveLoudnessMeter, formatLufs, measureIntegratedLufs } from '../loudness'

function sine(frequency: number, seconds: number, sampleRate: number, amplitude = 1): Float32Array {
  const out = new Float32Array(Math.round(seconds * sampleRate))
  for (let i = 0; i < out.length; i++) {
    out[i] = amplitude * Math.sin((2 * Math.PI * frequency * i) / sampleRate)
  }
  return out
}

suite('measureIntegratedLufs', () => {
  // BS.1770's stated calibration: a 0 dBFS 997 Hz sine in ONE channel
  // reads −3.01 LKFS. Both channels then add 3 dB → ~0 LKFS.
  test('full-scale 997 Hz sine, one channel ≈ −3.01 LUFS', () => {
    const mono = [sine(997, 3, 48000)]
    const lufs = measureIntegratedLufs(mono, 48000)
    expect(lufs).not.toBeNull()
    expect(lufs!).toBeCloseTo(-3.01, 1)
  })

  test('full-scale 997 Hz sine, both stereo channels ≈ 0 LUFS', () => {
    const wave = sine(997, 3, 48000)
    const lufs = measureIntegratedLufs([wave, wave], 48000)
    expect(lufs).not.toBeNull()
    expect(Math.abs(lufs!)).toBeLessThan(0.15)
  })

  test('the measurement holds at 44.1 kHz (coefficients are rate-derived)', () => {
    const mono = [sine(997, 3, 44100)]
    const lufs = measureIntegratedLufs(mono, 44100)
    expect(lufs).not.toBeNull()
    expect(lufs!).toBeCloseTo(-3.01, 1)
  })

  test('amplitude scales the reading by the expected dB', () => {
    // Half amplitude = −6.02 dB below the full-scale reference.
    const mono = [sine(997, 3, 48000, 0.5)]
    const lufs = measureIntegratedLufs(mono, 48000)
    expect(lufs).not.toBeNull()
    expect(lufs!).toBeCloseTo(-3.01 - 6.02, 1)
  })

  test('gating: trailing silence does not drag the integrated value down', () => {
    // A long enough tone that the few blocks straddling the tone→silence
    // boundary (which legitimately pass the relative gate) stay negligible.
    const tone = sine(997, 8, 48000)
    const padded = new Float32Array(tone.length * 4) // 8 s tone + 24 s silence
    padded.set(tone, 0)
    const toneOnly = measureIntegratedLufs([tone], 48000)!
    const withSilence = measureIntegratedLufs([padded], 48000)!
    expect(Math.abs(withSilence - toneOnly)).toBeLessThan(0.2)
  })

  test('silence and too-short signals return null', () => {
    expect(measureIntegratedLufs([new Float32Array(48000)], 48000)).toBeNull()
    expect(measureIntegratedLufs([sine(997, 0.2, 48000)], 48000)).toBeNull()
    expect(measureIntegratedLufs([], 48000)).toBeNull()
  })
})

suite('LiveLoudnessMeter', () => {
  /** Feed in deliberately awkward chunk sizes so bin boundaries land mid-chunk. */
  function feed(meter: LiveLoudnessMeter, channels: readonly Float32Array[], chunk = 997): void {
    const frames = channels[0]?.length ?? 0
    for (let offset = 0; offset < frames; offset += chunk) {
      const end = Math.min(frames, offset + chunk)
      meter.process(channels.map((c) => c.subarray(offset, end)))
    }
  }

  test('calibration tone reads −3.01 LUFS momentary once the window fills', () => {
    const meter = new LiveLoudnessMeter(48000, 1)
    feed(meter, [sine(997, 0.6, 48000)])
    expect(meter.momentaryLufs()).not.toBeNull()
    expect(meter.momentaryLufs()!).toBeCloseTo(-3.01, 1)
  })

  test('nothing to report before the windows fill', () => {
    const meter = new LiveLoudnessMeter(48000, 1)
    feed(meter, [sine(997, 0.3, 48000)])
    expect(meter.momentaryLufs()).toBeNull()
    expect(meter.shortTermLufs()).toBeNull()
  })

  test('short-term needs its full 3 s window, then matches the tone', () => {
    const wave = sine(997, 3.2, 48000)
    const meter = new LiveLoudnessMeter(48000, 1)
    feed(meter, [wave.subarray(0, Math.round(2.9 * 48000))])
    expect(meter.shortTermLufs()).toBeNull()
    feed(meter, [wave.subarray(Math.round(2.9 * 48000))])
    expect(meter.shortTermLufs()).not.toBeNull()
    expect(meter.shortTermLufs()!).toBeCloseTo(-3.01, 1)
  })

  test('stereo channel energies sum: the tone in both channels ≈ 0 LUFS', () => {
    const wave = sine(997, 0.6, 48000)
    const meter = new LiveLoudnessMeter(48000, 2)
    feed(meter, [wave, wave])
    expect(Math.abs(meter.momentaryLufs()!)).toBeLessThan(0.15)
  })

  test('the streaming filter holds at 44.1 kHz too', () => {
    const meter = new LiveLoudnessMeter(44100, 1)
    feed(meter, [sine(997, 0.6, 44100)])
    expect(meter.momentaryLufs()!).toBeCloseTo(-3.01, 1)
  })

  test('agrees with the offline integrated measurement on a steady tone', () => {
    const wave = sine(440, 3.5, 48000, 0.25)
    const meter = new LiveLoudnessMeter(48000, 1)
    feed(meter, [wave], 4801)
    const integrated = measureIntegratedLufs([wave], 48000)
    expect(integrated).not.toBeNull()
    expect(meter.shortTermLufs()!).toBeCloseTo(integrated!, 1)
  })

  test('silence reads null, and reset clears the window', () => {
    const meter = new LiveLoudnessMeter(48000, 1)
    feed(meter, [sine(997, 0.6, 48000)])
    expect(meter.momentaryLufs()).not.toBeNull()
    meter.reset()
    expect(meter.momentaryLufs()).toBeNull()
    feed(meter, [new Float32Array(48000)])
    // A full window of pure silence has no loudness to report.
    expect(meter.momentaryLufs()).toBeNull()
    expect(meter.shortTermLufs()).toBeNull()
  })
})

suite('formatLufs', () => {
  test('one decimal with a real minus sign', () => {
    expect(formatLufs(-14)).toBe('−14.0 LUFS')
    expect(formatLufs(-13.94)).toBe('−13.9 LUFS')
    expect(formatLufs(0.04)).toBe('0.0 LUFS')
  })
})
