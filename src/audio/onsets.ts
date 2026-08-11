/**
 * Transient onset detection over an asset's peak envelope (the waveform's
 * interleaved [min, max] buckets) — no audio decoding, no extra DSP. One
 * pure function shared by waveform-peak snapping (renderer), the sampler's
 * SLICES mode (engine + offline render) and the slicer actions, so every
 * consumer agrees on where the hits are.
 */

/** Rising-edge threshold: this bucket vs. the local floor before it. */
const RISE_FACTOR = 1.8
/** Ignore anything quieter than this (absolute peak, 0..1). */
const MIN_LEVEL = 0.12
/** Two onsets closer than this are one hit (seconds). */
const MIN_SPACING_SEC = 0.05

/** Onset times in buffer seconds, from an interleaved [min,max] envelope. */
export function onsetsFromPeaks(peaks: ArrayLike<number>, peaksPerSecond: number): number[] {
  if (!(peaksPerSecond > 0)) return []
  const buckets = Math.floor(peaks.length / 2)
  const env = (i: number): number => Math.max(Math.abs(peaks[i * 2]), Math.abs(peaks[i * 2 + 1]))
  const out: number[] = []
  const spacing = Math.max(1, Math.round(MIN_SPACING_SEC * peaksPerSecond))
  let floor = 0
  for (let i = 0; i < buckets; i++) {
    const level = env(i)
    if (
      level >= MIN_LEVEL &&
      level > floor * RISE_FACTOR &&
      (out.length === 0 || i - out[out.length - 1] * peaksPerSecond >= spacing)
    ) {
      out.push(i / peaksPerSecond)
    }
    // The floor trails the envelope so a sustained note only fires once.
    floor = Math.max(level, floor * 0.82)
  }
  return out
}

/**
 * Cached per peaks array (the object IS the cache key, so eviction follows
 * the asset store's own lifetime — no id-keyed map to leak).
 */
const cache = new WeakMap<object, number[]>()

export function onsetsForPeaks(
  peaks: (ArrayLike<number> & object) | null,
  peaksPerSecond: number
): number[] {
  if (!peaks) return []
  const cached = cache.get(peaks)
  if (cached) return cached
  const onsets = onsetsFromPeaks(peaks, peaksPerSecond)
  cache.set(peaks, onsets)
  return onsets
}
