import { newId } from '@core/model/ids'
import { buildSliceToSamplerOp } from '@core/ops/sliceToSampler'
import { ticksPerSecond } from '@audio/scheduling'
import { projectStore } from '@/state/projectStore'
import { assetStore } from '@/state/audioInstance'
import { selection } from '@/state/selection'
import { statusNotice } from '@/state/statusNotice'
import { assetOnsets, clipOnsetTicks } from './peakSnap'
import { nextTrackColor } from './colors'

/**
 * The slicer: transient-based chopping. Two flavours, both built on the
 * same onset detector the drag-snap guides already use:
 *
 * - "Slice at transients" cuts an audio clip in place (ONE clip/slice op,
 *   one undo) so every hit becomes its own clip.
 * - "Slice to sampler" materializes a new MIDI track whose sampler plays
 *   the asset in SLICES mode, with a clip whose notes replay the original
 *   groove — rearrange the hits in the piano roll or the step sequencer.
 */

/** Onset cut positions strictly inside the clip, ascending and unique. */
function transientCuts(clipId: string): number[] {
  const state = projectStore.state
  const clip = state.clips[clipId]
  if (!clip || clip.assetId === null) return []
  if (state.tracks[clip.trackId]?.frozenAssetId) return []
  const tps = ticksPerSecond(state.tempo)
  const cuts: number[] = []
  for (const rel of clipOnsetTicks(clip, tps)) {
    const at = clip.start + Math.round(rel)
    if (at <= clip.start || at >= clip.start + clip.duration) continue
    if (cuts.length > 0 && at - cuts[cuts.length - 1] < 8) continue // merge hair-thin pieces
    cuts.push(at)
  }
  return cuts
}

export function canSliceAtTransients(clipId: string): boolean {
  return transientCuts(clipId).length > 0
}

export function sliceClipAtTransients(clipId: string): void {
  const at = transientCuts(clipId)
  if (at.length === 0) {
    statusNotice.show('No transients detected in this clip.')
    return
  }
  projectStore.dispatch({
    type: 'clip/slice',
    slices: [{ clipId, at, newClipIds: at.map(() => newId('clp')) }]
  })
}

/** Slice a bay asset (or a clip's asset) onto a new sliced-sampler track. */
export function sliceAssetToSampler(assetId: string): void {
  const asset = assetStore.get(assetId)
  if (!asset || asset.seconds === null) {
    statusNotice.show('That sample has not finished loading yet.')
    return
  }
  const state = projectStore.state
  const op = buildSliceToSamplerOp(
    state,
    { id: assetId, name: asset.name, seconds: asset.seconds },
    assetOnsets(assetId),
    { index: state.trackOrder.length, color: nextTrackColor(state.trackOrder.length) }
  )
  if (!op) {
    statusNotice.show('Not enough transients to slice this sample.')
    return
  }
  projectStore.dispatch(op)
  if (op.type === 'track/create') {
    selection.select(op.clips[0]?.id ?? null, op.track.id)
    statusNotice.show(
      `Sliced "${asset.name}" onto a sampler track — keys from C1 play the slices.`
    )
  }
}

export function canSliceClipToSampler(clipId: string): boolean {
  return projectStore.state.clips[clipId]?.assetId !== null
}

export function sliceClipToSampler(clipId: string): void {
  const assetId = projectStore.state.clips[clipId]?.assetId
  if (assetId) sliceAssetToSampler(assetId)
}
