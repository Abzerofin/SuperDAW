import type { Clip, Note, ProjectState, Track } from '../model/types'
import { PPQ, ticksPerBar } from '../model/timebase'
import { newId } from '../model/ids'
import {
  INSTRUMENT_KINDS,
  SLICE_BASE_PITCH,
  synthDefaults
} from '../model/effects'
import { sliceRegions } from '../model/slices'
import type { Operation } from './operations'

/**
 * Builds the operation behind "Slice to sampler": a NEW MIDI track whose
 * sampler instrument holds the asset in SLICES mode, plus one MIDI clip
 * whose notes replay the slices in their original groove (note i =
 * SLICE_BASE_PITCH + i at onset i's timeline position) — the classic
 * chopped-break workflow, ready to rearrange in the piano roll or the
 * step sequencer.
 *
 * Like buildDuplicateTrackOp / buildMidiTakeOp this is deliberately NOT a
 * new op type: everything is materialized here with fresh ids and shipped
 * as one `track/create`, so undo (one Ctrl+Z removes track, clip and
 * notes), describe and sync all apply unchanged. Onsets come from the
 * caller (the audio layer's transient detector); fewer than two slices
 * build nothing.
 */
export function buildSliceToSamplerOp(
  state: ProjectState,
  asset: { id: string; name: string; seconds: number },
  onsetsSec: readonly number[],
  options: { index: number; color: string; startTicks?: number }
): Operation | null {
  const regions = sliceRegions(onsetsSec, asset.seconds)
  if (regions.length < 2) return null

  const tps = (state.tempo / 60) * PPQ
  const bar = ticksPerBar(state.timeSignature)
  const trackId = newId('trk')
  const clipId = newId('clp')
  const clipStart = Math.max(0, Math.round(options.startTicks ?? 0))

  const track: Track = {
    id: trackId,
    kind: 'midi',
    name: `${asset.name} Slices`,
    color: options.color,
    muted: false,
    soloed: false,
    parentId: null,
    frozenAssetId: null,
    samplerAssetId: asset.id,
    volume: 1,
    pan: 0,
    synth: {
      ...synthDefaults(),
      instrument: INSTRUMENT_KINDS.indexOf('sampler'),
      smpMode: 1
    }
  }

  const notes: Note[] = regions.map((region, i) => {
    const start = Math.round(region.startSec * tps)
    return {
      id: newId('not'),
      clipId,
      pitch: SLICE_BASE_PITCH + i,
      start,
      duration: Math.max(1, Math.round(region.endSec * tps) - start),
      velocity: 100
    }
  })

  const contentEnd = Math.round(asset.seconds * tps)
  const clip: Clip = {
    id: clipId,
    trackId,
    name: asset.name,
    start: clipStart,
    duration: Math.max(bar, Math.ceil(contentEnd / bar) * bar),
    assetId: null,
    offset: 0,
    color: null,
    fadeIn: 0,
    fadeOut: 0,
    reverse: false,
    pitch: 0,
    stretch: 1,
    loopLength: 0
  }

  return {
    type: 'track/create',
    track,
    index: Math.max(0, Math.round(options.index)),
    clips: [clip],
    automation: [],
    notes,
    plugins: []
  }
}
