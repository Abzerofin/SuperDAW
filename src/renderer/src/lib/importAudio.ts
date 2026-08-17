import type { Clip, FileNode, FileNodeId, Note, Track } from '@core/model/types'
import { newId } from '@core/model/ids'
import { barsToTicks, ticksPerBar } from '@core/model/timebase'
import { parseSmf } from '@core/midi/smf'
import { ticksPerSecond } from '@audio/scheduling'
import { digestOf, type ProjectAsset } from '@audio/assets'
import { conformLoopToTempo, loopMetaForBytes, type LoopConform } from '@audio/loopMeta'
import { audioEngine, assetStore } from '@/state/audioInstance'
import { projectStore } from '@/state/projectStore'
import { preferences } from '@/state/preferences'
import { statusNotice } from '@/state/statusNotice'
import { createTrack } from './trackActions'

/** How many files decode at once. Decoding is off-thread; reads parallelize. */
const IMPORT_CONCURRENCY = 4

const AUDIO_EXTENSIONS = /\.(wav|mp3|flac|ogg|m4a|aac|aiff?)$/i
const MIDI_EXTENSIONS = /\.(mid|midi)$/i

/**
 * REX loops (ReCycle). The container's audio is compressed with a
 * proprietary, undocumented codec — decoding it needs the licensed REX
 * SDK, which cannot ship here (see docs/LOOP_FORMATS.md). Recognized so a
 * drop gets one honest notice instead of a silent skip or a failed decode.
 */
const REX_EXTENSIONS = /\.(rx2|rex|rcy)$/i

/** One status-bar notice for any REX files in a drop; they import as nothing. */
function noticeRexFiles(files: readonly File[]): void {
  const rex = files.filter((file) => REX_EXTENSIONS.test(file.name))
  if (rex.length === 0) return
  const label = rex.length === 1 ? `"${rex[0].name}"` : `${rex.length} REX files`
  statusNotice.show(
    `${label} skipped — REX loops need conversion (export as WAV/AIFF from ReCycle or Reason; see docs/LOOP_FORMATS.md).`
  )
}

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

/**
 * Loop-conform info for an asset against the CURRENT project tempo, from
 * the WAV's ACID chunk (nothing proprietary is ever stored — this is
 * re-derived from the encoded bytes whenever needed). Null = not a
 * conformable loop.
 */
function loopConformFor(asset: ProjectAsset): LoopConform | null {
  if (asset.kind !== 'audio' || asset.seconds === null) return null
  const meta = loopMetaForBytes(asset.encoded, asset.ext)
  return conformLoopToTempo(meta, asset.seconds, projectStore.state.tempo)
}

/** A tempo-bearing loop clip an import just created (for the notice/ask flow). */
interface LoopImportEntry {
  readonly clipId: string
  readonly name: string
  readonly fileTempo: number
  /** True when the clip was created already conformed (preference 'always'). */
  readonly conformed: boolean
}

/** A clip (with MIDI notes) placing an asset on a track. */
function clipFor(
  asset: ProjectAsset,
  track: Track,
  startTicks: number
): { clip: Clip; notes: Note[]; loop: LoopImportEntry | null } {
  const clipId = newId('clp')
  const { notes, totalTicks } = midiNotesFor(asset, clipId)
  const conform = track.kind === 'audio' ? loopConformFor(asset) : null
  // A loop already AT the project tempo just gets its duration snapped to
  // its beat count — no audible change, perfect tiling, nothing to ask.
  // Otherwise the tempo-conform preference decides: 'always' bakes the
  // stretch into the created clip (same tape-style conform as
  // project/setTempo), 'ask' imports plain and offers a one-click
  // status-bar action, 'never' imports plain.
  const applied =
    conform !== null && (conform.stretch === 1 || preferences.tempoConform === 'always')
      ? conform
      : null
  const duration = applied !== null ? applied.durationTicks : clipDurationTicks(asset, totalTicks)
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
      stretch: applied !== null ? applied.stretch : 1,
      loopLength: 0
    },
    notes,
    loop:
      conform !== null && conform.stretch !== 1
        ? {
            clipId,
            name: baseName(asset.name),
            fileTempo: conform.fileTempo,
            conformed: applied !== null
          }
        : null
  }
}

/**
 * Stretch already-imported loop clips onto the project tempo — the
 * "Stretch to fit" notice action. Everything is re-derived at click time
 * (current tempo, current clip positions), and skips clips that vanished
 * meanwhile. ONE clip/resizeMany: one click, one op, one undo.
 */
function conformImportedLoops(clipIds: readonly string[]): void {
  const state = projectStore.state
  const edits: Array<{
    clipId: string
    start: number
    duration: number
    offset: number
    stretch: number
  }> = []
  for (const clipId of clipIds) {
    const clip = state.clips[clipId]
    if (!clip || clip.assetId === null) continue
    const asset = assetStore.get(clip.assetId)
    if (!asset) continue
    const conform = loopConformFor(asset)
    if (!conform) continue
    edits.push({
      clipId,
      start: clip.start,
      duration: conform.durationTicks,
      offset: clip.offset,
      stretch: conform.stretch
    })
  }
  if (edits.length > 0) projectStore.dispatch({ type: 'clip/resizeMany', edits })
}

/**
 * One notice per import batch about tempo-bearing loops. Under 'always'
 * the clips were created conformed and the notice just says so; under
 * 'ask' the notice carries the actual question as a one-click action
 * (mirroring the tempo field's conform ask, without a popup mid-drop).
 */
function noticeLoopImports(loops: readonly LoopImportEntry[]): void {
  if (loops.length === 0) return
  const tempo = projectStore.state.tempo
  const conformed = loops.filter((l) => l.conformed)
  if (conformed.length > 0) {
    statusNotice.show(
      conformed.length === 1
        ? `Stretched "${conformed[0].name}" (${conformed[0].fileTempo} BPM loop) to ${tempo} BPM.`
        : `Stretched ${conformed.length} loops to ${tempo} BPM.`
    )
    return
  }
  if (preferences.tempoConform !== 'ask') return
  const pending = loops.filter((l) => !l.conformed)
  if (pending.length === 0) return
  statusNotice.show(
    pending.length === 1
      ? `"${pending[0].name}" is a ${pending[0].fileTempo} BPM loop — project is ${tempo} BPM.`
      : `${pending.length} imported loops carry their own tempo — project is ${tempo} BPM.`,
    { label: 'Stretch to fit', run: () => conformImportedLoops(pending.map((p) => p.clipId)) }
  )
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
  noticeRexFiles(files)
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
  noticeRexFiles(files)
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
  const loops: LoopImportEntry[] = []
  for (const asset of assets) {
    const placed = clipFor(asset, track, cursor)
    clips.push(placed.clip)
    notes.push(...placed.notes)
    if (placed.loop) loops.push(placed.loop)
    cursor += placed.clip.duration
  }
  if (clips.length === 1) {
    projectStore.dispatch({ type: 'clip/create', clip: clips[0], notes })
  } else if (clips.length > 1) {
    projectStore.dispatch({ type: 'clip/createMany', clips, notes })
  }
  noticeLoopImports(loops)
  reportFailedImports(failed)
}

/**
 * Import OS files onto NEW tracks — the empty drop bar under the track
 * list. One track per file, named after it and typed from its contents,
 * with the clip at the song start.
 */
export async function importFilesAsNewTracks(files: readonly File[]): Promise<void> {
  noticeRexFiles(files)
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
  const loops: LoopImportEntry[] = []
  for (let i = 0; i < accepted.length; i++) {
    const asset = assets[i]
    if (!asset) continue
    // The track must exist before the clip op referencing it.
    const track = createTrack(asset.kind, baseName(accepted[i].name))
    const placed = clipFor(asset, track, 0)
    clips.push(placed.clip)
    notes.push(...placed.notes)
    if (placed.loop) loops.push(placed.loop)
  }
  if (clips.length === 1) {
    projectStore.dispatch({ type: 'clip/create', clip: clips[0], notes })
  } else if (clips.length > 1) {
    projectStore.dispatch({ type: 'clip/createMany', clips, notes })
  }
  noticeLoopImports(loops)
  reportFailedImports(failed)
}

const MEDIA_PICKER_ACCEPT = 'audio/*,.wav,.mp3,.flac,.ogg,.m4a,.aac,.aif,.aiff,.mid,.midi'

const AUDIO_PICKER_ACCEPT = 'audio/*,.wav,.mp3,.flac,.ogg,.m4a,.aac,.aif,.aiff'

/** Hidden-input OS file picker (works identically in Electron and browser). */
function pickMediaFiles(
  onPicked: (files: File[]) => void,
  options: { multiple?: boolean; accept?: string } = {}
): void {
  const input = document.createElement('input')
  input.type = 'file'
  input.multiple = options.multiple ?? true
  input.accept = options.accept ?? MEDIA_PICKER_ACCEPT
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

/**
 * Pick ONE audio file and import it as an asset (with its File Bay entry,
 * exactly as a drop would), handing back the asset id — the click path for
 * anything that plays a sample without owning a clip, e.g. a pad.
 */
export function browseForAudioAsset(onImported: (assetId: string) => void): void {
  pickMediaFiles(
    (files) => {
      void (async () => {
        const failed: string[] = []
        const [asset] = await importAssetBatch(files.slice(0, 1), failed)
        if (asset) {
          const nodes = bayNodesFor([asset], null)
          if (nodes.length > 0) projectStore.dispatch({ type: 'file/create', nodes })
          onImported(asset.id)
        }
        reportFailedImports(failed)
      })()
    },
    { multiple: false, accept: AUDIO_PICKER_ACCEPT }
  )
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
  // Same path as an OS-file drop, so ACID loop metadata gets the same
  // conform treatment; the bay entry's (possibly renamed) name wins.
  const placed = clipFor(asset, track, Math.max(0, startTicks))
  projectStore.dispatch({
    type: 'clip/create',
    clip: { ...placed.clip, name: payload.name },
    notes: placed.notes
  })
  noticeLoopImports(placed.loop ? [{ ...placed.loop, name: payload.name }] : [])
}
