import type { FileNodeId, Track } from '@core/model/types'
import { newId } from '@core/model/ids'
import { barsToTicks } from '@core/model/timebase'
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

/** One import = one op: asset's bay entry (and optional clip) undo together. */
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
  const durationTicks = clipDurationTicks(asset)
  if (clipTarget) {
    projectStore.dispatch({
      type: 'clip/create',
      clip: {
        id: newId('clp'),
        trackId: clipTarget.track.id,
        name: baseName(asset.name),
        start: clipTarget.startTicks,
        duration: durationTicks,
        assetId: asset.id,
        offset: 0,
        color: null
      }
    })
  }
  return durationTicks
}

export function clipDurationTicks(asset: ProjectAsset): number {
  if (asset.seconds !== null) {
    return Math.max(1, Math.round(asset.seconds * ticksPerSecond(projectStore.state.tempo)))
  }
  // Unknown length (MIDI, un-decoded audio): a sensible default.
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
  projectStore.dispatch({
    type: 'clip/create',
    clip: {
      id: newId('clp'),
      trackId: track.id,
      name: payload.name,
      start: Math.max(0, startTicks),
      duration: clipDurationTicks(asset),
      assetId: asset.id,
      offset: 0,
      color: null
    }
  })
}
