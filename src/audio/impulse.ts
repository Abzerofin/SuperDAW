/**
 * The builtin reverb's impulse response — pure data generation, no Web
 * Audio, so both the effect builders and the native backend's tests can
 * speak it (and so it registers with any backend as plain channels).
 */

/** Stable id for a decay's impulse, so instances share one registration. */
export function impulseBufferId(decaySeconds: number, sampleRate: number): string {
  return `sd!ir!${Math.round(sampleRate)}!${decaySeconds.toFixed(2)}`
}

/**
 * Stereo exponentially-decaying noise impulse.
 *
 * Seeded per (rate, decay, channel), NOT Math.random(): reverb must
 * render identically on every run and machine — bounces and freezes are
 * shared artifacts, and parity/native verification diffs renders exactly.
 */
export function makeImpulse(sampleRate: number, decaySeconds: number): Float32Array[] {
  const length = Math.max(1, Math.round(sampleRate * decaySeconds))
  const channels: Float32Array[] = []
  for (let ch = 0; ch < 2; ch++) {
    const data = new Float32Array(length)
    let seed = (0x2545f491 ^ Math.round(sampleRate * decaySeconds)) + ch * 0x9e3779b9
    for (let i = 0; i < length; i++) {
      seed = (seed + 0x6d2b79f5) | 0
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
      const noise = (((t ^ (t >>> 14)) >>> 0) / 4294967296) * 2 - 1
      data[i] = noise * Math.pow(1 - i / length, 2.5)
    }
    channels.push(data)
  }
  return channels
}
