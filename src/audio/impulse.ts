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

// ---------------------------------------------------------------------------
// Reverb Pro: a shaped, damped, width-controlled impulse response.
// ---------------------------------------------------------------------------

/** The IR-shaping half of the Reverb Pro params (pre-delay and mix live on
 *  graph nodes, not in the impulse). */
export interface ProImpulseParams {
  /** Tail length, seconds — the -60 dB point of the exponential decay. */
  readonly decaySeconds: number
  /** 0..1 — progressive high-frequency rolloff along the tail. */
  readonly damping: number
  /** 0..1 — attack bloom: 0 is plate-tight, 1 is a slow hall build-up. */
  readonly size: number
  /** 0..1 — inter-channel decorrelation: 0 mono, 1 fully independent. */
  readonly width: number
}

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v))

/**
 * Stable id for a Reverb Pro impulse, so instances at the same settings
 * share one registration (the same contract as impulseBufferId). The
 * two-decimal quantization here is ALSO the regeneration threshold: an
 * apply() whose params round to the same id reuses the buffer untouched.
 */
export function proImpulseBufferId(params: ProImpulseParams, sampleRate: number): string {
  const q = (v: number): string => v.toFixed(2)
  return `sd!irpro!${Math.round(sampleRate)}!${q(params.decaySeconds)}!${q(
    clamp01(params.damping)
  )}!${q(clamp01(params.size))}!${q(clamp01(params.width))}`
}

/** The same mulberry32-style generator makeNoise/makeImpulse inline. */
function noiseStream(seed: number): () => number {
  let s = seed | 0
  return () => {
    s = (s + 0x6d2b79f5) | 0
    let t = Math.imul(s ^ (s >>> 15), 1 | s)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return (((t ^ (t >>> 14)) >>> 0) / 4294967296) * 2 - 1
  }
}

/** One integer seed from the quantized param tuple — every machine that
 *  asks for the same settings gets the same bytes. */
function proImpulseSeed(params: ProImpulseParams, sampleRate: number): number {
  const q = (v: number): number => Math.round(v * 100)
  let seed = 0x1f3a5c7d
  seed = Math.imul(seed ^ Math.round(sampleRate), 0x9e3779b1)
  seed = Math.imul(seed ^ q(params.decaySeconds), 0x85ebca6b)
  seed = Math.imul(seed ^ q(clamp01(params.damping)), 0xc2b2ae35)
  seed = Math.imul(seed ^ q(clamp01(params.size)), 0x27d4eb2f)
  seed = Math.imul(seed ^ q(clamp01(params.width)), 0x165667b1)
  return seed
}

/**
 * Stereo plate/hall impulse response: exponentially decaying noise
 * (-60 dB exactly at `decaySeconds`), an attack bloom scaled by `size`,
 * a one-pole lowpass whose cutoff slides down the tail with `damping`
 * (real rooms lose highs faster than lows), and `width` mixing a shared
 * noise stream against per-channel independent ones (energy-normalized)
 * for mono-to-wide stereo control.
 *
 * SEEDED per quantized (rate, params) tuple, NOT Math.random(): renders
 * must be byte-identical across runs and machines — bounces and freezes
 * are shared artifacts and the parity harness diffs renders exactly.
 */
export function makeProImpulse(sampleRate: number, params: ProImpulseParams): Float32Array[] {
  const decay = Math.max(0.05, params.decaySeconds)
  const damping = clamp01(params.damping)
  const size = clamp01(params.size)
  const width = clamp01(params.width)
  const length = Math.max(1, Math.round(sampleRate * decay))

  const seed = proImpulseSeed(params, sampleRate)
  const shared = noiseStream(seed)
  const independent = [noiseStream(seed ^ 0x9e3779b9), noiseStream(seed ^ 0x3c6ef372)]

  // Decorrelation mix, normalized so total energy is width-independent.
  const wIndep = width
  const wShared = 1 - width
  const norm = 1 / Math.sqrt(Math.max(1e-6, wShared * wShared + wIndep * wIndep))

  // Attack bloom: plates speak instantly, halls take tens of ms to build.
  const buildSec = 0.004 + 0.1 * size

  // Progressive damping: a one-pole lowpass per channel whose cutoff
  // slides from FC_MAX down to FC_MAX*FC_FLOOR_RATIO^damping across the
  // tail — so damping 0 is (near-)transparent and 1 rolls the end of the
  // tail off below ~160 Hz.
  const FC_MAX = 16000
  const FC_FLOOR_RATIO = 0.01
  const filterState = [0, 0]

  const channels = [new Float32Array(length), new Float32Array(length)]
  for (let i = 0; i < length; i++) {
    const t = i / sampleRate
    const attack = Math.min(1, t / buildSec)
    const env = Math.pow(10, (-3 * t) / decay) * attack * attack
    const fc = FC_MAX * Math.pow(FC_FLOOR_RATIO, (damping * t) / decay)
    const alpha = 1 - Math.exp((-2 * Math.PI * fc) / sampleRate)
    const s = shared()
    for (let ch = 0; ch < 2; ch++) {
      const raw = norm * (wShared * s + wIndep * independent[ch]())
      filterState[ch] += alpha * (raw - filterState[ch])
      channels[ch][i] = filterState[ch] * env
    }
  }
  return channels
}
