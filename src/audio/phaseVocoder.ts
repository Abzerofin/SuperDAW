/**
 * Phase-vocoder time stretch — pure DSP over Float32Array channels, no
 * Web Audio. Stretching a clip WITHOUT transposing it (the thing the
 * tape-style resample cannot do) works by re-timing the signal's STFT:
 * analysis frames are read from the source at one hop, written at
 * another, and each bin's phase is advanced by its TRUE instantaneous
 * frequency so partials stay continuous across the new frame spacing.
 *
 * Identity phase locking (Laroche–Dolson) keeps each spectral peak's
 * neighborhood rotating as one unit, which is what separates a usable
 * stretch from underwater mush: only peak bins get the free-running
 * phase; every bin in a peak's region of influence keeps its original
 * phase RELATIVE to that peak.
 *
 * The warped-buffer contract: `stretchChannels(channels, factor)` returns
 * channels of length ≈ round(length · factor), same pitch, same speed
 * relationship everywhere (uniform stretch — tempo maps would drive this
 * per-region later). Deterministic: same input, same output, everywhere —
 * warped audio is derived data shared between the engine, the offline
 * render, and (implicitly) collaborators, exactly like reversed copies.
 */

import { fft } from './fft'

/** STFT geometry: 4096-sample Hann frames, 75 % overlap on the synthesis side. */
const FRAME = 4096

/** Stretch factors outside this range are clamped (matches MIN/MAX_STRETCH headroom). */
export const MIN_WARP = 0.25
export const MAX_WARP = 4

const hannWindow = (() => {
  const w = new Float32Array(FRAME)
  for (let i = 0; i < FRAME; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / FRAME)
  return w
})()

function wrapPhase(phase: number): number {
  return phase - 2 * Math.PI * Math.round(phase / (2 * Math.PI))
}

/** Frames processed between generator yields (≈ a few ms of CPU each). */
const FRAMES_PER_SLICE = 24

/**
 * Stretch ONE channel by `factor` (>1 = longer/slower, same pitch), as a
 * generator yielding between slices — the sync driver runs it straight
 * through, the async driver parks between slices so a minutes-long asset
 * never freezes the UI thread while it warps.
 */
function* stretchChannelGen(
  input: Float32Array,
  factor: number
): Generator<void, Float32Array> {
  const outLength = Math.max(1, Math.round(input.length * factor))
  if (input.length < FRAME * 2) {
    // Too short for a stable STFT: linear resample as a graceful floor
    // (sub-85 ms scraps; the tape artifact is inaudible at that size).
    const out = new Float32Array(outLength)
    for (let i = 0; i < outLength; i++) {
      const pos = (i / Math.max(1, outLength - 1)) * (input.length - 1)
      const i0 = Math.floor(pos)
      const t = pos - i0
      out[i] = input[i0] * (1 - t) + (input[Math.min(input.length - 1, i0 + 1)] ?? 0) * t
    }
    return out
  }

  // The ANALYSIS hop must stay ≤ FRAME/4: the phase-unwrap ambiguity is
  // ±π/analysisHop, and a longer hop narrows it below the half-bin offset
  // a partial can sit at (audible as a few Hz of drift under compression).
  // Stretching keeps the synthesis hop at FRAME/4; compressing shrinks it
  // so the analysis side never exceeds FRAME/4.
  const synthHop = Math.max(32, Math.round((FRAME / 4) * Math.min(1, factor)))

  const bins = FRAME / 2
  const out = new Float32Array(outLength + FRAME)
  const norm = new Float32Array(outLength + FRAME)

  const re = new Float64Array(FRAME)
  const im = new Float64Array(FRAME)
  const prevPhase = new Float64Array(bins + 1)
  const outPhase = new Float64Array(bins + 1)
  const magnitude = new Float64Array(bins + 1)
  const phase = new Float64Array(bins + 1)
  /** Bin index of the nearest dominating peak, per bin (phase locking). */
  const peakOf = new Int32Array(bins + 1)

  const frames = Math.max(1, Math.ceil(outLength / synthHop))
  let prevAnalysisPos = -1

  for (let frameIndex = 0; frameIndex < frames; frameIndex++) {
    if (frameIndex > 0 && frameIndex % FRAMES_PER_SLICE === 0) yield
    // Where this synthesis frame reads from in the source (fractional
    // positions rounded; the phase math uses the ACTUAL hop, so rounding
    // never accumulates).
    const analysisPos = Math.min(
      input.length - FRAME,
      Math.round((frameIndex * synthHop) / factor)
    )
    const writePos = frameIndex * synthHop

    for (let i = 0; i < FRAME; i++) {
      re[i] = (input[analysisPos + i] ?? 0) * hannWindow[i]
      im[i] = 0
    }
    fft(re, im, false)

    for (let bin = 0; bin <= bins; bin++) {
      magnitude[bin] = Math.hypot(re[bin], im[bin])
      phase[bin] = Math.atan2(im[bin], re[bin])
    }

    if (prevAnalysisPos < 0) {
      // First frame: output phases start as the input's.
      for (let bin = 0; bin <= bins; bin++) outPhase[bin] = phase[bin]
    } else {
      const actualHop = analysisPos - prevAnalysisPos
      // Peaks: local magnitude maxima; every bin belongs to the nearest
      // peak's region of influence (boundaries at magnitude valleys).
      let currentPeak = 0
      for (let bin = 0; bin <= bins; bin++) {
        const isPeak =
          magnitude[bin] > (magnitude[bin - 1] ?? 0) &&
          magnitude[bin] > (magnitude[bin - 2] ?? 0) &&
          magnitude[bin] >= (magnitude[bin + 1] ?? 0) &&
          magnitude[bin] >= (magnitude[bin + 2] ?? 0)
        if (isPeak) currentPeak = bin
        peakOf[bin] = currentPeak
      }
      // Refine: a bin closer to the NEXT peak should belong to it.
      for (let bin = bins; bin >= 0; bin--) {
        const next = bin === bins ? peakOf[bin] : peakOf[bin + 1]
        if (next !== peakOf[bin] && next - bin < bin - peakOf[bin]) peakOf[bin] = next
      }
      // Free-running phase for the peaks, from each peak's true frequency.
      for (let bin = 0; bin <= bins; bin++) {
        if (peakOf[bin] !== bin) continue
        const omega = (2 * Math.PI * bin) / FRAME
        const deviation = wrapPhase(phase[bin] - prevPhase[bin] - omega * actualHop)
        const trueFreq = omega + (actualHop > 0 ? deviation / actualHop : 0)
        outPhase[bin] += trueFreq * synthHop
      }
      // Locked bins ride their peak: original phase RELATIVE to the peak.
      for (let bin = 0; bin <= bins; bin++) {
        const peak = peakOf[bin]
        if (peak !== bin) outPhase[bin] = outPhase[peak] + (phase[bin] - phase[peak])
      }
    }
    for (let bin = 0; bin <= bins; bin++) prevPhase[bin] = phase[bin]
    prevAnalysisPos = analysisPos

    // Rebuild the frame from magnitudes + advanced phases (conjugate
    // symmetry for the upper half) and overlap-add.
    for (let bin = 0; bin <= bins; bin++) {
      re[bin] = magnitude[bin] * Math.cos(outPhase[bin])
      im[bin] = magnitude[bin] * Math.sin(outPhase[bin])
    }
    for (let bin = bins + 1; bin < FRAME; bin++) {
      re[bin] = re[FRAME - bin]
      im[bin] = -im[FRAME - bin]
    }
    fft(re, im, true)
    for (let i = 0; i < FRAME; i++) {
      const at = writePos + i
      const w = hannWindow[i]
      out[at] += re[i] * w
      norm[at] += w * w
    }
  }

  // Normalize by the accumulated window energy (flat in the steady state;
  // the guard keeps frame edges from dividing by ~0).
  const result = new Float32Array(outLength)
  for (let i = 0; i < outLength; i++) {
    result[i] = norm[i] > 1e-6 ? out[i] / norm[i] : 0
  }
  return result
}

function runToEnd(gen: Generator<void, Float32Array>): Float32Array {
  for (;;) {
    const step = gen.next()
    if (step.done) return step.value
  }
}

/** Stretch every channel by `factor` (clamped to the supported range). */
export function stretchChannels(
  channels: readonly Float32Array[],
  factor: number
): Float32Array[] {
  const clamped = Math.min(MAX_WARP, Math.max(MIN_WARP, factor))
  if (clamped === 1) return channels.map((c) => new Float32Array(c))
  return channels.map((channel) => runToEnd(stretchChannelGen(channel, clamped)))
}

/**
 * The same stretch, sliced across macrotasks so the UI thread breathes —
 * the warped-buffer cache computes long assets through this.
 */
export async function stretchChannelsAsync(
  channels: readonly Float32Array[],
  factor: number
): Promise<Float32Array[]> {
  const clamped = Math.min(MAX_WARP, Math.max(MIN_WARP, factor))
  if (clamped === 1) return channels.map((c) => new Float32Array(c))
  const out: Float32Array[] = []
  for (const channel of channels) {
    const gen = stretchChannelGen(channel, clamped)
    for (;;) {
      const step = gen.next()
      if (step.done) {
        out.push(step.value)
        break
      }
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
  }
  return out
}
