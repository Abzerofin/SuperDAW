import { MAX_SLICES } from './effects'

/**
 * Slice-region math for the sampler's SLICES mode: transient onset times
 * (buffer seconds, detected in the audio layer from an asset's peak
 * envelope) become contiguous regions, one per playable slice. This is the
 * single definition shared by the audio voice builders and the
 * slice-to-sampler op builder, so a chopped break triggers exactly the
 * material the generated notes were built from.
 *
 * Onsets are detected per client from decoded audio, so boundaries may
 * differ across machines by fractions of a millisecond — which is why
 * document data only ever references slices by INDEX, never by time.
 */
export interface SliceRegion {
  readonly startSec: number
  readonly endSec: number
}

/** Ignore a leading region shorter than this — it is the same transient. */
const LEAD_IN_SEC = 0.06
/** Two onsets closer than this collapse into one slice. */
const MIN_SLICE_SEC = 0.01

export function sliceRegions(onsetsSec: readonly number[], totalSec: number): SliceRegion[] {
  if (!Number.isFinite(totalSec) || totalSec <= 0) return []
  const sorted = onsetsSec
    .filter((sec) => Number.isFinite(sec) && sec >= 0 && sec < totalSec)
    .sort((a, b) => a - b)
  const starts: number[] = []
  for (const sec of sorted) {
    if (starts.length > 0 && sec - starts[starts.length - 1] < MIN_SLICE_SEC) continue
    starts.push(sec)
  }
  // Material before the first onset is its own slice — unless the first
  // onset is effectively the start of the file.
  if (starts.length === 0 || starts[0] > LEAD_IN_SEC) starts.unshift(0)
  const capped = starts.slice(0, MAX_SLICES)
  return capped.map((startSec, i) => ({
    startSec,
    endSec: i + 1 < capped.length ? capped[i + 1] : totalSec
  }))
}
