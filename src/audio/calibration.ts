/**
 * Loopback latency calibration — the pure DSP half (docs/NATIVE_AUDIO_BACKEND.md §7).
 *
 * A short exponential sine sweep (chirp) is played at a known clock time
 * and captured back through the input path — via a physical loopback cable
 * or acoustically speaker→mic. A chirp's matched filter produces a sharp,
 * noise-robust correlation peak, so cross-correlating the capture against
 * the reference sweep gives the true round-trip delay to the sample.
 *
 * Everything here is math over Float32Arrays: no Web Audio, no DOM. The
 * runtime half (playing/capturing on a live context) lives in
 * calibrationRun.ts; policy (repeat, gate on confidence, persist) in
 * renderer/state/latencyCalibration.ts.
 */

/** Sweep length. Long enough for ~110× matched-filter gain, short enough not to be annoying. */
export const CHIRP_SECONDS = 0.25
/** Sweep band: above mains rumble, inside every speaker/mic's comfortable range. */
export const CHIRP_START_HZ = 150
export const CHIRP_END_HZ = 4500
/** Raised-cosine edge so the sweep never clicks (clicks correlate badly). */
const EDGE_SECONDS = 0.005

/** Delays beyond this are not a working audio path (even Bluetooth fits). */
export const MAX_LAG_SEC = 0.6
/** Measurements are repeated and the median taken (docs §7: "repeat 3×"). */
export const REPEAT_COUNT = 3
/** Peak-to-sidelobe ratio below which a detection is not trusted. */
export const MIN_CONFIDENCE = 3
/** Repeats disagreeing by more than this mean the path is unstable — refuse. */
export const MAX_SPREAD_SEC = 0.002
/** Sidelobe search ignores this window around the peak (mainlobe width ≪ this). */
const SIDELOBE_EXCLUDE_SEC = 0.003

/** The reference sweep at a given rate. Deterministic — the matched filter's template. */
export function generateChirp(sampleRate: number): Float32Array {
  const length = Math.round(CHIRP_SECONDS * sampleRate)
  const out = new Float32Array(length)
  const ratio = CHIRP_END_HZ / CHIRP_START_HZ
  const phaseScale = (2 * Math.PI * CHIRP_START_HZ * CHIRP_SECONDS) / Math.log(ratio)
  const edge = Math.max(1, Math.round(EDGE_SECONDS * sampleRate))
  for (let i = 0; i < length; i++) {
    const t = i / sampleRate
    const phase = phaseScale * (Math.pow(ratio, t / CHIRP_SECONDS) - 1)
    let amp = 1
    if (i < edge) amp = 0.5 - 0.5 * Math.cos((Math.PI * i) / edge)
    else if (i >= length - edge) amp = 0.5 - 0.5 * Math.cos((Math.PI * (length - 1 - i)) / edge)
    out[i] = amp * Math.sin(phase)
  }
  return out
}

/**
 * In-place iterative radix-2 FFT (re/im pairs, length a power of two).
 * Double precision; twiddles accumulate by multiplication, whose rounding
 * error random-walks at ~1e-14 over even the largest sizes used here —
 * far below anything a correlation peak could notice.
 */
function fft(re: Float64Array, im: Float64Array, inverse: boolean): void {
  const n = re.length
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) {
      const tr = re[i]
      re[i] = re[j]
      re[j] = tr
      const ti = im[i]
      im[i] = im[j]
      im[j] = ti
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const angle = ((inverse ? 1 : -1) * 2 * Math.PI) / len
    const stepRe = Math.cos(angle)
    const stepIm = Math.sin(angle)
    const half = len >> 1
    for (let i = 0; i < n; i += len) {
      let wRe = 1
      let wIm = 0
      for (let k = 0; k < half; k++) {
        const a = i + k
        const b = a + half
        const vRe = re[b] * wRe - im[b] * wIm
        const vIm = re[b] * wIm + im[b] * wRe
        re[b] = re[a] - vRe
        im[b] = im[a] - vIm
        re[a] += vRe
        im[a] += vIm
        const nextRe = wRe * stepRe - wIm * stepIm
        wIm = wRe * stepIm + wIm * stepRe
        wRe = nextRe
      }
    }
  }
  if (inverse) {
    for (let i = 0; i < n; i++) {
      re[i] /= n
      im[i] /= n
    }
  }
}

export interface ChirpMatch {
  /** Offset of the sweep's first sample within the capture. */
  readonly lagSamples: number
  /** Peak-to-sidelobe ratio of the correlation — the detection's quality. */
  readonly confidence: number
}

/**
 * Locate the reference sweep inside a capture by FFT cross-correlation.
 * Polarity-blind (|corr| — some paths invert), gain-blind (the ratio is
 * scale-invariant). Returns null when the capture cannot contain the sweep
 * or holds no signal at all; a poor detection returns with LOW confidence
 * rather than null, so the caller decides the threshold.
 */
export function findChirp(
  capture: Float32Array,
  reference: Float32Array,
  sampleRate: number
): ChirpMatch | null {
  const maxLag = capture.length - reference.length
  if (maxLag < 0) return null
  let n = 1
  while (n < capture.length + reference.length) n <<= 1
  const aRe = new Float64Array(n)
  const aIm = new Float64Array(n)
  const bRe = new Float64Array(n)
  const bIm = new Float64Array(n)
  aRe.set(capture)
  bRe.set(reference)
  fft(aRe, aIm, false)
  fft(bRe, bIm, false)
  // A × conj(B): the inverse transform is then the cross-correlation,
  // lag k at index k (the zero-padding to ≥ capture+reference keeps the
  // circular wraparound out of the lags we read).
  for (let i = 0; i < n; i++) {
    const cRe = aRe[i] * bRe[i] + aIm[i] * bIm[i]
    const cIm = aIm[i] * bRe[i] - aRe[i] * bIm[i]
    aRe[i] = cRe
    aIm[i] = cIm
  }
  fft(aRe, aIm, true)

  let peak = 0
  let peakLag = 0
  for (let k = 0; k <= maxLag; k++) {
    const v = Math.abs(aRe[k])
    if (v > peak) {
      peak = v
      peakLag = k
    }
  }
  if (peak <= 0) return null

  const exclude = Math.max(1, Math.round(SIDELOBE_EXCLUDE_SEC * sampleRate))
  let sidelobe = 0
  for (let k = 0; k <= maxLag; k++) {
    if (Math.abs(k - peakLag) <= exclude) continue
    const v = Math.abs(aRe[k])
    if (v > sidelobe) sidelobe = v
  }
  return {
    lagSamples: peakLag,
    confidence: sidelobe > 0 ? peak / sidelobe : Number.POSITIVE_INFINITY
  }
}

export interface MeasurementSummary {
  /** Median of the repeated round trips — the value to store. */
  readonly roundTripSec: number
  /** max − min across repeats; a large spread means an unstable path. */
  readonly spreadSec: number
}

/** Fold repeated round-trip measurements into one result (median + spread). */
export function summarizeMeasurements(lagsSec: readonly number[]): MeasurementSummary | null {
  if (lagsSec.length === 0) return null
  const sorted = [...lagsSec].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  const roundTripSec =
    sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
  return { roundTripSec, spreadSec: sorted[sorted.length - 1] - sorted[0] }
}
