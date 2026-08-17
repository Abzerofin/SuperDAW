/**
 * Integrated loudness per ITU-R BS.1770-4 / EBU R128: K-weighting (a high
 * shelf modelling the head, then a high-pass), mean square over 400 ms
 * blocks with 75 % overlap, an absolute −70 LUFS gate, then a relative
 * −10 LU gate. Pure math over raw channel data — no Web Audio — so the
 * exact same measurement runs after an offline render and in unit tests.
 *
 * This is what makes the project's loudness TARGET (settings.
 * loudnessTargetLufs) actionable: after a bounce the measured value is
 * compared against the target the session is mixing toward.
 */

interface BiquadCoeffs {
  b0: number
  b1: number
  b2: number
  a1: number
  a2: number
}

/**
 * Stage 1: spherical-head high shelf (+4 dB above ~1.5 kHz). The spec
 * tabulates coefficients for 48 kHz only; these closed forms reproduce
 * that table and stay correct at any rate (parameters from the ITU
 * filter-design derivation used across open implementations).
 */
function shelfCoeffs(sampleRate: number): BiquadCoeffs {
  const f0 = 1681.974450955533
  const gainDb = 3.999843853973347
  const q = 0.7071752369554196
  const k = Math.tan((Math.PI * f0) / sampleRate)
  const vh = Math.pow(10, gainDb / 20)
  const vb = Math.pow(vh, 0.4996667741545416)
  const a0 = 1 + k / q + k * k
  return {
    b0: (vh + (vb * k) / q + k * k) / a0,
    b1: (2 * (k * k - vh)) / a0,
    b2: (vh - (vb * k) / q + k * k) / a0,
    a1: (2 * (k * k - 1)) / a0,
    a2: (1 - k / q + k * k) / a0
  }
}

/** Stage 2: the RLB high-pass (removes inaudible rumble from the measure). */
function highpassCoeffs(sampleRate: number): BiquadCoeffs {
  const f0 = 38.13547087602444
  const q = 0.5003270373238773
  const k = Math.tan((Math.PI * f0) / sampleRate)
  const a0 = 1 + k / q + k * k
  return {
    b0: 1,
    b1: -2,
    b2: 1,
    a1: (2 * (k * k - 1)) / a0,
    a2: (1 - k / q + k * k) / a0
  }
}

/** BS.1770 channel weights: L/R/C at 1, surrounds at ~+1.5 dB. */
function channelWeight(index: number): number {
  return index >= 3 ? 1.41 : 1
}

/** Mean-square energy → LUFS (the spec's −0.691 offset included). */
function lufsOf(energy: number): number {
  return -0.691 + 10 * Math.log10(energy)
}

/**
 * The K-weighting kernel in streaming form: run `data[from..to)` through
 * both filter stages (direct form II transposed — `state` holds the four
 * delay slots starting at `base`, and keeps them across calls) and return
 * the sum of squared output samples. Both the offline integrated
 * measurement and the live meter run their samples through this one
 * function, so a realtime reading and a bounce report can never disagree
 * on the filter.
 */
function kWeightSumSquares(
  data: Float32Array,
  from: number,
  to: number,
  shelf: BiquadCoeffs,
  hp: BiquadCoeffs,
  state: Float64Array,
  base: number
): number {
  let s1a = state[base]
  let s1b = state[base + 1]
  let s2a = state[base + 2]
  let s2b = state[base + 3]
  let sum = 0
  for (let i = from; i < to; i++) {
    const x = data[i]
    const y1 = shelf.b0 * x + s1a
    s1a = shelf.b1 * x - shelf.a1 * y1 + s1b
    s1b = shelf.b2 * x - shelf.a2 * y1
    const y2 = hp.b0 * y1 + s2a
    s2a = hp.b1 * y1 - hp.a1 * y2 + s2b
    s2b = hp.b2 * y1 - hp.a2 * y2
    sum += y2 * y2
  }
  state[base] = s1a
  state[base + 1] = s1b
  state[base + 2] = s2a
  state[base + 3] = s2b
  return sum
}

/**
 * Integrated loudness of raw channel data, in LUFS. Null when the signal
 * is shorter than one 400 ms gating block or nothing survives the
 * absolute gate (silence).
 */
export function measureIntegratedLufs(
  channels: readonly Float32Array[],
  sampleRate: number
): number | null {
  const frames = channels[0]?.length ?? 0
  if (channels.length === 0 || sampleRate <= 0) return null
  const hop = Math.round(0.1 * sampleRate) // 100 ms — blocks overlap 75 %
  const blockHops = 4 // 400 ms gating block
  if (hop <= 0 || frames < hop * blockHops) return null

  // One pass per channel: K-weight the samples and bin the squared output
  // per 100 ms hop; a gating block is then the sum of 4 consecutive bins.
  const binCount = Math.floor(frames / hop)
  const weighted = new Float64Array(binCount) // channel-weighted energy sums
  const shelf = shelfCoeffs(sampleRate)
  const hp = highpassCoeffs(sampleRate)
  const state = new Float64Array(4)
  for (let ch = 0; ch < channels.length; ch++) {
    const data = channels[ch]
    const weight = channelWeight(ch)
    state.fill(0)
    for (let bin = 0; bin < binCount; bin++) {
      const sum = kWeightSumSquares(data, bin * hop, (bin + 1) * hop, shelf, hp, state, 0)
      weighted[bin] += (weight * sum) / hop
    }
  }

  // Mean square per 400 ms block → block loudness → two-stage gating.
  const blockCount = binCount - blockHops + 1
  const blockEnergy = new Float64Array(blockCount)
  for (let block = 0; block < blockCount; block++) {
    let sum = 0
    for (let i = 0; i < blockHops; i++) sum += weighted[block + i]
    blockEnergy[block] = sum / blockHops
  }
  const absoluteGate = -70
  let passing: number[] = []
  for (const energy of blockEnergy) {
    if (energy > 0 && lufsOf(energy) > absoluteGate) passing.push(energy)
  }
  if (passing.length === 0) return null

  const mean = (values: readonly number[]): number =>
    values.reduce((a, b) => a + b, 0) / values.length
  const relativeGate = lufsOf(mean(passing)) - 10
  passing = passing.filter((energy) => lufsOf(energy) > relativeGate)
  if (passing.length === 0) return null
  return lufsOf(mean(passing))
}

/** Bins per momentary window: 4 × 100 ms = the spec's 400 ms. */
const MOMENTARY_BINS = 4
/** Bins per short-term window: 30 × 100 ms = EBU R128's 3 s. */
const SHORT_TERM_BINS = 30

/**
 * Streaming momentary / short-term loudness — EBU R128's "M" (400 ms) and
 * "S" (3 s), both ungated per the spec. The exact K-weighting and 100 ms
 * binning of the integrated measurement above, but incremental: feed it
 * whatever chunk sizes a realtime tap delivers and read the windows
 * whenever a frame paints. Pure math, no Web Audio — the calibration facts
 * hold (a 0 dBFS 997 Hz sine in one channel reads −3.01 LUFS momentary
 * once the window fills). Windows report null until they have filled, and
 * on pure silence (zero energy), so a UI can show a placeholder instead
 * of −Infinity.
 */
export class LiveLoudnessMeter {
  private readonly hop: number
  private readonly shelf: BiquadCoeffs
  private readonly hp: BiquadCoeffs
  /** Four DF2T delay slots per channel, [channel * 4 ..]. */
  private readonly state: Float64Array
  /** Ring of completed 100 ms bin energies (channel-weighted mean squares). */
  private readonly bins = new Float64Array(SHORT_TERM_BINS)
  /** Completed bins so far, monotonic — also the ring's write cursor. */
  private binsDone = 0
  private currentSum = 0
  private currentFill = 0

  constructor(
    sampleRate: number,
    private readonly maxChannels: number
  ) {
    this.hop = sampleRate > 0 ? Math.round(0.1 * sampleRate) : 0
    this.shelf = shelfCoeffs(sampleRate)
    this.hp = highpassCoeffs(sampleRate)
    this.state = new Float64Array(Math.max(1, maxChannels) * 4)
  }

  /**
   * Feed one chunk. Every channel must carry the same frame count (extra
   * channels beyond the constructor's count are ignored); chunks may be
   * any length, including empty — bin boundaries land wherever they land.
   */
  process(channels: readonly Float32Array[]): void {
    if (this.hop <= 0) return
    const frames = channels[0]?.length ?? 0
    const count = Math.min(channels.length, this.maxChannels)
    let offset = 0
    while (offset < frames) {
      const n = Math.min(frames - offset, this.hop - this.currentFill)
      for (let ch = 0; ch < count; ch++) {
        const sum = kWeightSumSquares(
          channels[ch],
          offset,
          offset + n,
          this.shelf,
          this.hp,
          this.state,
          ch * 4
        )
        this.currentSum += (channelWeight(ch) * sum) / this.hop
      }
      this.currentFill += n
      offset += n
      if (this.currentFill === this.hop) {
        this.bins[this.binsDone % SHORT_TERM_BINS] = this.currentSum
        this.binsDone++
        this.currentSum = 0
        this.currentFill = 0
      }
    }
  }

  /** Mean energy of the last `binCount` completed bins, as LUFS. */
  private windowLufs(binCount: number): number | null {
    if (this.binsDone < binCount) return null
    let energy = 0
    for (let i = this.binsDone - binCount; i < this.binsDone; i++) {
      energy += this.bins[i % SHORT_TERM_BINS]
    }
    energy /= binCount
    return energy > 0 ? lufsOf(energy) : null
  }

  momentaryLufs(): number | null {
    return this.windowLufs(MOMENTARY_BINS)
  }

  shortTermLufs(): number | null {
    return this.windowLufs(SHORT_TERM_BINS)
  }

  /** Back to empty — filter state, windows and the partial bin all clear. */
  reset(): void {
    this.state.fill(0)
    this.bins.fill(0)
    this.binsDone = 0
    this.currentSum = 0
    this.currentFill = 0
  }
}

/** "−14.0 LUFS" — one decimal, real minus sign, for status lines. */
export function formatLufs(value: number): string {
  const rounded = Math.round(value * 10) / 10
  return `${rounded < 0 ? '−' : ''}${Math.abs(rounded).toFixed(1)} LUFS`
}
