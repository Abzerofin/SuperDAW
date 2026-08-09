/**
 * Biquad frequency-response math for drawing EQ curves — the same RBJ /
 * Web Audio spec coefficient formulas the audible BiquadFilterNodes use,
 * so the drawn curve is exactly what the filters do. Pure math, no audio.
 */

// Fixed analysis sample rate; the audible nodes use the context's real
// rate, but the difference is invisible at 20 Hz–20 kHz.
export const SR = 48000
export const FMIN = 20
export const FMAX = 20000

export interface Biquad {
  b0: number
  b1: number
  b2: number
  a0: number
  a1: number
  a2: number
}

/** Web Audio spec shelving filter (shelf slope S = 1, Q unused). */
export function shelf(f0: number, gainDb: number, high: boolean): Biquad {
  const A = Math.pow(10, gainDb / 40)
  const w0 = (2 * Math.PI * f0) / SR
  const cos = Math.cos(w0)
  const alpha = (Math.sin(w0) / 2) * Math.SQRT2
  const k = 2 * Math.sqrt(A) * alpha
  if (high) {
    return {
      b0: A * (A + 1 + (A - 1) * cos + k),
      b1: -2 * A * (A - 1 + (A + 1) * cos),
      b2: A * (A + 1 + (A - 1) * cos - k),
      a0: A + 1 - (A - 1) * cos + k,
      a1: 2 * (A - 1 - (A + 1) * cos),
      a2: A + 1 - (A - 1) * cos - k
    }
  }
  return {
    b0: A * (A + 1 - (A - 1) * cos + k),
    b1: 2 * A * (A - 1 - (A + 1) * cos),
    b2: A * (A + 1 - (A - 1) * cos - k),
    a0: A + 1 + (A - 1) * cos + k,
    a1: -2 * (A - 1 + (A + 1) * cos),
    a2: A + 1 + (A - 1) * cos - k
  }
}

export function peaking(f0: number, q: number, gainDb: number): Biquad {
  const A = Math.pow(10, gainDb / 40)
  const w0 = (2 * Math.PI * f0) / SR
  const cos = Math.cos(w0)
  const alpha = Math.sin(w0) / (2 * q)
  return {
    b0: 1 + alpha * A,
    b1: -2 * cos,
    b2: 1 - alpha * A,
    a0: 1 + alpha / A,
    a1: -2 * cos,
    a2: 1 - alpha / A
  }
}

export function lowpass(f0: number, q: number): Biquad {
  const w0 = (2 * Math.PI * f0) / SR
  const cos = Math.cos(w0)
  const alpha = Math.sin(w0) / (2 * q)
  return {
    b0: (1 - cos) / 2,
    b1: 1 - cos,
    b2: (1 - cos) / 2,
    a0: 1 + alpha,
    a1: -2 * cos,
    a2: 1 - alpha
  }
}

export function highpass(f0: number, q: number): Biquad {
  const w0 = (2 * Math.PI * f0) / SR
  const cos = Math.cos(w0)
  const alpha = Math.sin(w0) / (2 * q)
  return {
    b0: (1 + cos) / 2,
    b1: -(1 + cos),
    b2: (1 + cos) / 2,
    a0: 1 + alpha,
    a1: -2 * cos,
    a2: 1 - alpha
  }
}

export function notch(f0: number, q: number): Biquad {
  const w0 = (2 * Math.PI * f0) / SR
  const cos = Math.cos(w0)
  const alpha = Math.sin(w0) / (2 * q)
  return {
    b0: 1,
    b1: -2 * cos,
    b2: 1,
    a0: 1 + alpha,
    a1: -2 * cos,
    a2: 1 - alpha
  }
}

export function magnitudeDb(bq: Biquad, f: number): number {
  const w = (2 * Math.PI * f) / SR
  const c1 = Math.cos(w)
  const s1 = Math.sin(w)
  const c2 = Math.cos(2 * w)
  const s2 = Math.sin(2 * w)
  const nr = bq.b0 + bq.b1 * c1 + bq.b2 * c2
  const ni = bq.b1 * s1 + bq.b2 * s2
  const dr = bq.a0 + bq.a1 * c1 + bq.a2 * c2
  const di = bq.a1 * s1 + bq.a2 * s2
  return 10 * Math.log10((nr * nr + ni * ni) / (dr * dr + di * di))
}

/** Log-frequency axis mapping for a canvas of width w. */
export const xToFreq = (x: number, w: number): number => FMIN * Math.pow(FMAX / FMIN, x / w)
export const freqToX = (f: number, w: number): number =>
  (Math.log(f / FMIN) / Math.log(FMAX / FMIN)) * w

/**
 * PARAEQ_FILTER_TYPES index → response for one parametric EQ band.
 * Mirrors the type mapping in audio/effects.ts.
 */
export function paraeqBand(typeIndex: number, freq: number, q: number, gainDb: number): Biquad {
  switch (typeIndex) {
    case 1:
      return shelf(freq, gainDb, false)
    case 2:
      return shelf(freq, gainDb, true)
    case 3:
      return highpass(freq, q)
    case 4:
      return lowpass(freq, q)
    case 5:
      return notch(freq, q)
    default:
      return peaking(freq, q, gainDb)
  }
}
