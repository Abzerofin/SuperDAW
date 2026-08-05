import type { FileNodeId, Note, Track } from '@core/model/types'
import { newId } from '@core/model/ids'
import { barsToTicks, ticksPerBar } from '@core/model/timebase'
import { parseSmf } from '@core/midi/smf'
import { ticksPerSecond } from '@audio/scheduling'
import type { ProjectAsset } from '@audio/assets'
import { audioEngine, assetStore } from '@/state/audioInstance'
import { projectStore } from '@/state/projectStore'

const AUDIO_EXTENSIONS = /\.(wav|mp3|flac|ogg|m4a|aac|aiff?)$/i
const MIDI_EXTENSIONS = /\.(mid|midi)$/i

export function isAudioFile(file: File): boolean {
  return file.type.startsWith('audio/') || AUDIO_EXTENSIONS.test(file.name)
}

export function isMidiFile(file: File): boolean {
  return MIDI_EXTENSIONS.test(file.name)
}

function extOf(name: string): string {
  return name.match(/\.([^.]+)$/)?.[1]?.toLowerCase() ?? 'bin'
}

function baseName(name: string): string {
  return name.replace(/\.[^.]+$/, '')
}

/**
 * Decode a dropped file into an asset. Audio decodes to a buffer; MIDI is
 * stored as raw bytes until the piano-roll milestone brings parsing.
 * Returns null for unsupported files.
 */
async function importAsset(file: File): Promise<ProjectAsset | null> {
  if (isMidiFile(file)) {
    return assetStore.addMidi(file.name, extOf(file.name), new Uint8Array(await file.arrayBuffer()))
  }
  if (isAudioFile(file)) {
    const encoded = new Uint8Array(await file.arrayBuffer())
    // decodeAudioData detaches the buffer it is given — decode a copy.
    const buffer = await audioEngine.decode(encoded.slice().buffer)
    return assetStore.addAudio(file.name, extOf(file.name), encoded, buffer)
  }
  return null
}

/** Notes for a MIDI asset, remapped onto a fresh clip id. */
function midiNotesFor(asset: ProjectAsset, clipId: string): { notes: Note[]; totalTicks: number } {
  if (asset.kind !== 'midi') return { notes: [], totalTicks: 0 }
  try {
    const parsed = parseSmf(asset.encoded)
    return {
      notes: parsed.notes.map((n) => ({
        id: newId('not'),
        clipId,
        pitch: n.pitch,
        start: n.start,
        duration: n.duration,
        velocity: n.velocity
      })),
      totalTicks: parsed.totalTicks
    }
  } catch (error) {
    console.warn(`Could not parse MIDI in "${asset.name}"`, error)
    return { notes: [], totalTicks: 0 }
  }
}

/** One import = one op per concern: bay entry, then clip (with its notes). */
function dispatchImported(
  asset: ProjectAsset,
  folderId: FileNodeId | null,
  clipTarget: { track: Track; startTicks: number } | null
): number {
  projectStore.dispatch({
    type: 'file/create',
    nodes: [
      {
        id: newId('fil'),
        parentId: folderId,
        kind: asset.kind,
        name: baseName(asset.name),
        assetId: asset.id
      }
    ]
  })
  if (!clipTarget) return clipDurationTicks(asset, 0)

  const clipId = newId('clp')
  const { notes, totalTicks } = midiNotesFor(asset, clipId)
  const durationTicks = clipDurationTicks(asset, totalTicks)
  projectStore.dispatch({
    type: 'clip/create',
    clip: {
      id: clipId,
      trackId: clipTarget.track.id,
      name: baseName(asset.name),
      start: clipTarget.startTicks,
      duration: durationTicks,
      assetId: asset.id,
      offset: 0,
      color: null
    },
    notes
  })
  return durationTicks
}

export function clipDurationTicks(asset: ProjectAsset, midiTicks = 0): number {
  if (asset.seconds !== null) {
    return Math.max(1, Math.round(asset.seconds * ticksPerSecond(projectStore.state.tempo)))
  }
  if (midiTicks > 0) {
    // Round MIDI content up to whole bars so the clip sits neatly on the grid.
    const bar = ticksPerBar(projectStore.state.timeSignature)
    return Math.max(bar, Math.ceil(midiTicks / bar) * bar)
  }
  return barsToTicks(4, projectStore.state.timeSignature)
}

/** Import OS files into a File Bay folder. */
export async function importFilesToBay(
  files: readonly File[],
  folderId: FileNodeId | null
): Promise<void> {
  for (const file of files) {
    try {
      const asset = await importAsset(file)
      if (asset) dispatchImported(asset, folderId, null)
    } catch (error) {
      console.error(`Failed to import "${file.name}"`, error)
    }
  }
}

/**
 * Import OS files dropped on a track: bay entry (at root) + clip per file,
 * laid out back-to-back from the drop position. Clip length derives from
 * audio duration at the current tempo (no time-stretching).
 */
export async function importFilesToTrack(
  files: readonly File[],
  track: Track,
  startTicks: number
): Promise<void> {
  let cursor = Math.max(0, startTicks)
  for (const file of files) {
    const accepts = track.kind === 'audio' ? isAudioFile(file) : isMidiFile(file)
    if (!accepts) continue
    try {
      const asset = await importAsset(file)
      if (asset) cursor += dispatchImported(asset, null, { track, startTicks: cursor })
    } catch (error) {
      console.error(`Failed to import "${file.name}"`, error)
    }
  }
}

/** Payload for dragging an asset out of the File Bay (onto a track). */
export const BAY_DRAG_MIME = 'application/x-superdaw-asset'

export interface BayDragPayload {
  assetId: string
  kind: 'audio' | 'midi'
  name: string
}

/** Create a clip from a File Bay asset dropped on a track. */
export function createClipFromBayAsset(
  payload: BayDragPayload,
  track: Track,
  startTicks: number
): void {
  const asset = assetStore.get(payload.assetId)
  if (!asset || asset.kind !== track.kind) return
  const clipId = newId('clp')
  const { notes, totalTicks } = midiNotesFor(asset, clipId)
  projectStore.dispatch({
    type: 'clip/create',
    clip: {
      id: clipId,
      trackId: track.id,
      name: payload.name,
      start: Math.max(0, startTicks),
      duration: clipDurationTicks(asset, totalTicks),
      assetId: asset.id,
      offset: 0,
      color: null
    },
    notes
  })
}
