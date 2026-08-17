/**
 * The Saturator's transfer curve — pure math, no Web Audio, so the effect
 * builder, the offline render and the card visual all draw from the same
 * function (and so it unit-tests without a graph).
 */

/** Odd sample count ⇒ the curve has an exact center point at x = 0. */
export const SHAPER_CURVE_LENGTH = 2049

/**
 * The reference level the gain compensation holds still: a signal at
 * -6 dBFS comes out at -6 dBFS whatever the drive, so turning the drive
 * up adds density and harmonics rather than simply getting louder.
 */
const REF = 0.5

const dbToGain = (db: number): number => Math.pow(10, db / 20)

/**
 * Soft-clip one sample: tanh driven by `driveDb` of input gain, scaled so
 * the output at REF is exactly REF (gain-compensated — see REF). Odd
 * symmetric, monotonic, bounded: |out| ≤ REF / tanh(REF · g) ≤ ~1.09.
 */
export function saturate(x: number, driveDb: number): number {
  const g = dbToGain(driveDb)
  return (REF / Math.tanh(REF * g)) * Math.tanh(g * x)
}

/**
 * The WaveShaperNode curve for a drive setting, sampled over x ∈ [-1, 1].
 * Pure math — regenerated only when the drive param commits, never per
 * frame, and identical on every machine (collaboration invariant: bounces
 * and freezes must match across peers).
 */
export function makeShaperCurve(driveDb: number): Float32Array {
  const curve = new Float32Array(SHAPER_CURVE_LENGTH)
  const g = dbToGain(driveDb)
  const comp = REF / Math.tanh(REF * g)
  for (let i = 0; i < SHAPER_CURVE_LENGTH; i++) {
    const x = (2 * i) / (SHAPER_CURVE_LENGTH - 1) - 1
    curve[i] = comp * Math.tanh(g * x)
  }
  return curve
}

/**
 * The pre-emphasis shelf's center frequency. The `tone` param tilts highs
 * INTO the shaper here and back out after it (a tape-style emphasis /
 * de-emphasis pair): net frequency response stays flat while tone decides
 * whether the top end or the low mids carry the saturation.
 */
export const SATURATOR_TILT_HZ = 2500

/** Shelf gain in dB for a 0..1 tone value (0.5 = no tilt). */
export function saturatorTiltDb(tone: number): number {
  return (Math.min(1, Math.max(0, tone)) - 0.5) * 12
}
