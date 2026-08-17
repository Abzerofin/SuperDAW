import type { Clip, ProjectState } from '@core/model/types'
import { clipPlaybackRate, clipWarpFactor } from '@core/model/types'
import { ticksPerSecond } from '@audio/scheduling'
import { assetOnsetSeconds } from '@audio/loopMeta'
import { assetStore } from '@/state/audioInstance'

/**
 * Waveform-peak snapping: while dragging a clip, its transients can snap
 * into alignment with the transients of OTHER audio clips, so hits line
 * up sample-tight instead of merely grid-tight.
 *
 * Onsets are detected once per asset from the peak envelope the waveform
 * drawing already computed (120 buckets/s) and cached — no audio decoding
 * or extra DSP on the drag path.
 */

/** How many of the dragged clip's onsets take part in matching. */
const MAX_DRAG_ONSETS = 8

/**
 * Slice/onset times (buffer seconds) of an asset: the file's own cue
 * markers when it carries a usable set, else detected transients (cached
 * per peaks array). One seam with the engine and offline render.
 */
export function assetOnsets(assetId: string): number[] {
  const asset = assetStore.get(assetId)
  if (!asset) return []
  return assetOnsetSeconds(asset)
}

/**
 * A clip's onsets as TICKS from its start, honoring trim, rate and
 * reverse; only onsets inside the clip's (first loop period's) window.
 * Exported for the slicer ("Slice at transients" cuts exactly where the
 * drag-snap guides point).
 */
export function clipOnsetTicks(clip: Clip, tps: number): number[] {
  if (clip.assetId === null) return []
  const asset = assetStore.get(clip.assetId)
  if (asset?.seconds == null) return []
  // Source seconds → timeline ticks: warped material is warpFactor× the
  // source read at the pitch-only rate (tape reduces to 1/clipRate).
  const scale = clipWarpFactor(clip) / clipPlaybackRate(clip)
  const windowTicks = clip.loopLength > 0 ? Math.min(clip.loopLength, clip.duration) : clip.duration
  const out: number[] = []
  for (const sec of assetOnsets(clip.assetId)) {
    const bufferSec = clip.reverse ? asset.seconds - sec : sec
    const ticks = bufferSec * tps * scale - clip.offset
    if (ticks >= 0 && ticks < windowTicks) out.push(ticks)
  }
  return out.sort((a, b) => a - b)
}

export interface PeakSnapTargets {
  /** The dragged clip's own onsets, ticks from its start. */
  readonly dragOnsets: number[]
  /** Absolute onset ticks of every OTHER audio clip, sorted. */
  readonly others: number[]
}

/** Computed once when a drag begins; matching per-move is two binary searches. */
export function buildPeakSnapTargets(state: ProjectState, clipId: string): PeakSnapTargets {
  const tps = ticksPerSecond(state.tempo)
  const dragged = state.clips[clipId]
  const dragOnsets = dragged ? clipOnsetTicks(dragged, tps).slice(0, MAX_DRAG_ONSETS) : []
  const others: number[] = []
  for (const clip of Object.values(state.clips)) {
    if (clip.id === clipId || clip.assetId === null) continue
    for (const rel of clipOnsetTicks(clip, tps)) others.push(clip.start + rel)
  }
  others.sort((a, b) => a - b)
  return { dragOnsets, others }
}

/**
 * The clip start that best aligns one of the dragged clip's onsets with
 * another clip's onset, if any lies within `toleranceTicks` of the
 * proposed (unsnapped) start. Returns the start plus the aligned tick for
 * the guide line.
 */
export function peakSnapStart(
  targets: PeakSnapTargets,
  proposedStart: number,
  toleranceTicks: number
): { start: number; alignedTicks: number } | null {
  const { dragOnsets, others } = targets
  if (dragOnsets.length === 0 || others.length === 0) return null
  let best: { start: number; alignedTicks: number; distance: number } | null = null
  for (const rel of dragOnsets) {
    const wanted = proposedStart + rel
    // Binary search for the nearest other-onset to `wanted`.
    let lo = 0
    let hi = others.length - 1
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (others[mid] < wanted) lo = mid + 1
      else hi = mid
    }
    for (const idx of [lo - 1, lo]) {
      if (idx < 0 || idx >= others.length) continue
      const distance = Math.abs(others[idx] - wanted)
      if (distance <= toleranceTicks && (!best || distance < best.distance)) {
        best = { start: others[idx] - rel, alignedTicks: others[idx], distance }
      }
    }
  }
  return best ? { start: Math.max(0, Math.round(best.start)), alignedTicks: best.alignedTicks } : null
}
