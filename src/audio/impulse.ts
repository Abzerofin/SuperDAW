/**
 * Generated audio data the builtins need as plain channels — the reverb's
 * impulse response and the drum synth's noise. Pure, no Web Audio, so the
 * effect builders, the instruments and the native backend's tests all
 * speak the same bytes (and so it registers with any backend).
 */

/** Registered id for the drum synth's shared noise buffer. */
export function noiseBufferId(sampleRate: number): string {
  return `sd!noise!${Math.round(sampleRate)}`
}

/**
 * One second of white noise — the drum synth's hats, snare and clap all
 * read it. Seeded (mulberry32), NOT Math.random(): the same project must
 * render the same bytes on every run and every machine, since freezes and
 * bounces are shared with collaborators and the parity harness diffs
 * renders exactly. Noise is noise; only reproducibility changes.
 */
export function makeNoise(sampleRate: number): Float32Array[] {
  const data = new Float32Array(Math.ceil(sampleRate))
  let seed = 0x9e3779b9 ^ Math.round(sampleRate)
  for (let i = 0; i < data.length; i++) {
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    data[i] = (((t ^ (t >>> 14)) >>> 0) / 4294967296) * 2 - 1
  }
  return [data]
}

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
