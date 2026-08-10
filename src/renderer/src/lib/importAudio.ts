import type { Clip, FileNode, FileNodeId, Note, Track } from '@core/model/types'
import { newId } from '@core/model/ids'
import { barsToTicks, ticksPerBar } from '@core/model/timebase'
import { parseSmf } from '@core/midi/smf'
import { ticksPerSecond } from '@audio/scheduling'
import { digestOf, type ProjectAsset } from '@audio/assets'
import { audioEngine, assetStore } from '@/state/audioInstance'
import { projectStore } from '@/state/projectStore'
import { createTrack } from './trackActions'

/** How many files decode at once. Decoding is off-thread; reads parallelize. */
const IMPORT_CONCURRENCY = 4

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
    // Byte-identical content reuses the asset we already hold: no second
    // decode, no second copy in memory or in the saved project file.
    const digest = await digestOf(encoded)
    if (digest !== null) {
      const existing = assetStore.findByDigest(digest)
      if (existing && existing.kind === 'audio') return existing
    }
    // decodeAudioData detaches the buffer it is given — decode a copy.
    const buffer = await audioEngine.decode(encoded.slice().buffer)
    return assetStore.addAudio(file.name, extOf(file.name), encoded, buffer, digest ?? undefined)
  }
  return null
}

/**
 * Decode a batch with bounded concurrency, preserving input order. Serial
 * awaiting left three quarters of the machine idle while a folder of drops
 * trickled in one file at a time.
 */
async function importAssetBatch(
  files: readonly File[],
  failed: string[]
): Promise<Array<ProjectAsset | null>> {
  const results: Array<ProjectAsset | null> = new Array(files.length).fill(null)
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < files.length) {
      const index = next++
      const file = files[index]
      try {
        results[index] = await importAsset(file)
      } catch (error) {
        console.error(`Failed to import "${file.name}"`, error)
        failed.push(file.name)
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(IMPORT_CONCURRENCY, files.length) }, () => worker())
  )
  return results
}

/** A fresh bay entry for an asset, unless one already points at it. */
function bayNodesFor(assets: readonly ProjectAsset[], folderId: FileNodeId | null): FileNode[] {
  const existing = new Set<string>()
  for (const node of Object.values(projectStore.state.files)) {
    if (node.assetId) existing.add(node.assetId)
  }
  const nodes: FileNode[] = []
  const added = new Set<string>()
  for (const asset of assets) {
    if (existing.has(asset.id) || added.has(asset.id)) continue // deduped re-import
    added.add(asset.id)
    nodes.push({
      id: newId('fil'),
      parentId: folderId,
      kind: asset.kind,
      name: baseName(asset.name),
      assetId: asset.id
    })
  }
  return nodes
}

/**
 * The project's default micro-fade for a fresh AUDIO clip (anti-click,
 * Settings on the document — `settings.defaultFadeTicks`), clamped so both
 * fades always fit inside the clip. MIDI clips never fade by default.
 */
function defaultFadeFor(kind: 'audio' | 'midi', durationTicks: number): number {
  if (kind !== 'audio') return 0
  const wanted = projectStore.state.settings.defaultFadeTicks
  return Math.max(0, Math.min(wanted, Math.floor(durationTicks / 2)))
}

/** A clip (with MIDI notes) placing an asset on a track. */
function clipFor(
  asset: ProjectAsset,
  track: Track,
  startTicks: number
): { clip: Clip; notes: Note[] } {
  const clipId = newId('clp')
  const { notes, totalTicks } = midiNotesFor(asset, clipId)
  const duration = clipDurationTicks(asset, totalTicks)
  const fade = defaultFadeFor(asset.kind, duration)
  return {
    clip: {
      id: clipId,
      trackId: track.id,
      name: baseName(asset.name),
      start: startTicks,
      duration,
      assetId: asset.id,
      offset: 0,
      color: null,
      fadeIn: fade,
      fadeOut: fade,
      reverse: false,
      pitch: 0,
      stretch: 1,
      loopLength: 0
    },
    notes
  }
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

/**
 * An import that throws (decoding a large file when memory is already tight
 * is the common one) used to leave no trace but a console line — the file
 * simply never appeared, which reads as the app losing audio. Failures are
 * collected per batch and reported once, so dropping 40 files can't produce
 * 40 dialogs.
 */
function reportFailedImports(failed: string[]): void {
  if (failed.length === 0) return
  const list = failed.slice(0, 5).join('\n  ')
  const more = failed.length > 5 ? `\n  …and ${failed.length - 5} more` : ''
  window.alert(
    `Could not import ${failed.length} file${failed.length === 1 ? '' : 's'}:\n  ${list}${more}\n\n` +
      `Large or numerous files can exhaust memory — importing fewer at a time may help.`
  )
}

/** Import OS files into a File Bay folder. */
export async function importFilesToBay(
  files: readonly File[],
  folderId: FileNodeId | null
): Promise<void> {
  const failed: string[] = []
  const assets = (await importAssetBatch(files, failed)).filter(
    (a): a is ProjectAsset => a !== null
  )
  // ONE op for the whole drop: 40 files used to be 40 dispatches, 40
  // undo entries and 40 engine/UI reactions.
  const nodes = bayNodesFor(assets, folderId)
  if (nodes.length > 0) projectStore.dispatch({ type: 'file/create', nodes })
  reportFailedImports(failed)
}

/**
 * Import OS files dropped on a track: bay entry (at root) + clip per file,
 * laid out back-to-back from the drop position. Clip length derives from
 * audio duration at the current tempo (no time-stretching). The whole drop
 * is two ops — one for the bay entries, one for all the clips — so it is
 * one undo step and one reschedule.
 */
export async function importFilesToTrack(
  files: readonly File[],
  track: Track,
  startTicks: number
): Promise<void> {
  const failed: string[] = []
  const accepted = files.filter((file) =>
    track.kind === 'audio' ? isAudioFile(file) : isMidiFile(file)
  )
  const assets = (await importAssetBatch(accepted, failed)).filter(
    (a): a is ProjectAsset => a !== null
  )
  const nodes = bayNodesFor(assets, null)
  if (nodes.length > 0) projectStore.dispatch({ type: 'file/create', nodes })

  let cursor = Math.max(0, startTicks)
  const clips: Clip[] = []
  const notes: Note[] = []
  for (const asset of assets) {
    const placed = clipFor(asset, track, cursor)
    clips.push(placed.clip)
    notes.push(...placed.notes)
    cursor += placed.clip.duration
  }
  if (clips.length === 1) {
    projectStore.dispatch({ type: 'clip/create', clip: clips[0], notes })
  } else if (clips.length > 1) {
    projectStore.dispatch({ type: 'clip/createMany', clips, notes })
  }
  reportFailedImports(failed)
}

/**
 * Import OS files onto NEW tracks — the empty drop bar under the track
 * list. One track per file, named after it and typed from its contents,
 * with the clip at the song start.
 */
export async function importFilesAsNewTracks(files: readonly File[]): Promise<void> {
  const failed: string[] = []
  const accepted = files.filter((file) => isMidiFile(file) || isAudioFile(file))
  const assets = await importAssetBatch(accepted, failed)

  const nodes = bayNodesFor(
    assets.filter((a): a is ProjectAsset => a !== null),
    null
  )
  if (nodes.length > 0) projectStore.dispatch({ type: 'file/create', nodes })

  const clips: Clip[] = []
  const notes: Note[] = []
  for (let i = 0; i < accepted.length; i++) {
    const asset = assets[i]
    if (!asset) continue
    // The track must exist before the clip op referencing it.
    const track = createTrack(asset.kind, baseName(accepted[i].name))
    const placed = clipFor(asset, track, 0)
    clips.push(placed.clip)
    notes.push(...placed.notes)
  }
  if (clips.length === 1) {
    projectStore.dispatch({ type: 'clip/create', clip: clips[0], notes })
  } else if (clips.length > 1) {
    projectStore.dispatch({ type: 'clip/createMany', clips, notes })
  }
  reportFailedImports(failed)
}

const MEDIA_PICKER_ACCEPT = 'audio/*,.wav,.mp3,.flac,.ogg,.m4a,.aac,.aif,.aiff,.mid,.midi'

/** Hidden-input OS file picker (works identically in Electron and browser). */
function pickMediaFiles(onPicked: (files: File[]) => void): void {
  const input = document.createElement('input')
  input.type = 'file'
  input.multiple = true
  input.accept = MEDIA_PICKER_ACCEPT
  input.onchange = () => {
    const files = input.files
    if (files && files.length > 0) onPicked(Array.from(files))
  }
  input.click()
}

/** Open the OS file picker and import the choice as new tracks. */
export async function browseForMediaFiles(): Promise<void> {
  pickMediaFiles((files) => void importFilesAsNewTracks(files))
}

/**
 * Open the OS file picker and import the choice into a File Bay folder —
 * the click path to exactly what dropping files on the bay does.
 */
export function browseForBayFiles(folderId: FileNodeId | null): void {
  pickMediaFiles((files) => void importFilesToBay(files, folderId))
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
  const duration = clipDurationTicks(asset, totalTicks)
  const fade = defaultFadeFor(asset.kind, duration)
  projectStore.dispatch({
    type: 'clip/create',
    clip: {
      id: clipId,
      trackId: track.id,
      name: payload.name,
      start: Math.max(0, startTicks),
      duration,
      assetId: asset.id,
      offset: 0,
      color: null,
      fadeIn: fade,
      fadeOut: fade,
      reverse: false,
      pitch: 0,
      stretch: 1,
      loopLength: 0
    },
    notes
  })
}
