import type { ClipId, ProjectState, TrackId } from '@core/model/types'
import { MAX_STRETCH, MIN_STRETCH } from '@core/model/types'
import { ticksPerSecond } from '@audio/scheduling'
import { projectStore } from '@/state/projectStore'
import { assetStore } from '@/state/audioInstance'

/**
 * Tempo changes and the "audio follows the BPM" option. Clips live in
 * ticks, so a tempo change alone leaves audio playing at its old speed
 * while the grid moves underneath it; conforming scales each audio clip's
 * stretch by oldTempo/newTempo so the material keeps filling the same
 * bars (tape-style: speed and pitch move together).
 */

const clampTempo = (tempo: number): number => Math.min(400, Math.max(20, Math.round(tempo)))

/** Stretch edits that make audio clips follow a tempo change. */
export function tempoConformEntries(
  state: ProjectState,
  fromTempo: number,
  toTempo: number
): Array<{ clipId: ClipId; stretch: number }> {
  const target = clampTempo(toTempo)
  if (target === fromTempo) return []
  const out: Array<{ clipId: ClipId; stretch: number }> = []
  for (const clip of Object.values(state.clips)) {
    if (clip.assetId === null) continue
    const stretch =
      Math.round(
        Math.min(MAX_STRETCH, Math.max(MIN_STRETCH, (clip.stretch * fromTempo) / target)) * 1000
      ) / 1000
    if (stretch !== clip.stretch) out.push({ clipId: clip.id, stretch })
  }
  return out
}

/**
 * Stretch ONE track's audio clips so each clip's source material exactly
 * fills its bars at the current tempo — the per-track "adjust audio to the
 * BPM" action (track ⋯ menu). For a looped clip the loop period, not the
 * whole tiled length, holds the material. One clip/resizeMany per gesture.
 */
export function conformTrackAudioToTempo(trackId: TrackId): void {
  const state = projectStore.state
  const tps = ticksPerSecond(state.tempo)
  const edits: Array<{
    clipId: ClipId
    start: number
    duration: number
    offset: number
    stretch: number
  }> = []
  for (const clip of Object.values(state.clips)) {
    if (clip.trackId !== trackId || clip.assetId === null) continue
    const assetSec = assetStore.getSeconds(clip.assetId)
    if (assetSec === null || assetSec <= 0) continue
    const semis = Math.pow(2, clip.pitch / 12)
    const period =
      clip.loopLength > 0 ? Math.min(clip.loopLength, clip.duration) : clip.duration
    const stretch =
      Math.round(
        Math.min(
          MAX_STRETCH,
          Math.max(MIN_STRETCH, ((period + clip.offset) * semis) / (assetSec * tps))
        ) * 1000
      ) / 1000
    if (stretch !== clip.stretch) {
      edits.push({
        clipId: clip.id,
        start: clip.start,
        duration: clip.duration,
        offset: clip.offset,
        stretch
      })
    }
  }
  if (edits.length === 0) return
  projectStore.dispatch({ type: 'clip/resizeMany', edits })
}

/** ONE op: the tempo change, optionally carrying the audio conform. */
export function changeTempo(tempo: number, conformAudio: boolean): void {
  const state = projectStore.state
  const entries = conformAudio ? tempoConformEntries(state, state.tempo, tempo) : []
  projectStore.dispatch({
    type: 'project/setTempo',
    tempo: clampTempo(tempo),
    ...(entries.length > 0 ? { conform: entries } : {})
  })
}
