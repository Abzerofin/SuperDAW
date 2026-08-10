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
  for (let ch = 0; ch < channels.length; ch++) {
    const data = channels[ch]
    const weight = channelWeight(ch)
    // Direct form II transposed state, one pair per stage.
    let s1a = 0
    let s1b = 0
    let s2a = 0
    let s2b = 0
    for (let bin = 0; bin < binCount; bin++) {
      let sum = 0
      const end = (bin + 1) * hop
      for (let i = bin * hop; i < end; i++) {
        const x = data[i]
        const y1 = shelf.b0 * x + s1a
        s1a = shelf.b1 * x - shelf.a1 * y1 + s1b
        s1b = shelf.b2 * x - shelf.a2 * y1
        const y2 = hp.b0 * y1 + s2a
        s2a = hp.b1 * y1 - hp.a1 * y2 + s2b
        s2b = hp.b2 * y1 - hp.a2 * y2
        sum += y2 * y2
      }
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
  const loudnessOf = (energy: number): number => -0.691 + 10 * Math.log10(energy)

  const absoluteGate = -70
  let passing: number[] = []
  for (const energy of blockEnergy) {
    if (energy > 0 && loudnessOf(energy) > absoluteGate) passing.push(energy)
  }
  if (passing.length === 0) return null

  const mean = (values: readonly number[]): number =>
    values.reduce((a, b) => a + b, 0) / values.length
  const relativeGate = loudnessOf(mean(passing)) - 10
  passing = passing.filter((energy) => loudnessOf(energy) > relativeGate)
  if (passing.length === 0) return null
  return loudnessOf(mean(passing))
}

/** "−14.0 LUFS" — one decimal, real minus sign, for status lines. */
export function formatLufs(value: number): string {
  const rounded = Math.round(value * 10) / 10
  return `${rounded < 0 ? '−' : ''}${Math.abs(rounded).toFixed(1)} LUFS`
}
