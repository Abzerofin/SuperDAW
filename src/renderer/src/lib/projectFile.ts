import { strFromU8, strToU8, unzip, zip } from 'fflate'
import {
  assetPathInArchive,
  parseProjectJson,
  PROJECT_FILE_EXTENSION,
  referencedAssetIds,
  serializeProjectJson,
  type AssetManifestEntry
} from '@core/persistence/format'
import { createEmptyProject } from '@core/model/types'
import { canMerge, mergeForks } from '@core/merge/merge'
import { renderMixdown } from '@audio/render'
import { projectStore } from '@/state/projectStore'
import { assetStore, audioEngine } from '@/state/audioInstance'
import { transport } from '@/state/transport'
import { selection } from '@/state/selection'
import { sessionFile } from '@/state/sessionFile'
import { pianoRollUi } from '@/state/pianoRollUi'
import { recentProjects, type RecentProject } from '@/state/recentProjects'
import { appShell } from '@/state/appShell'
import { trackInputs } from '@/state/trackInputs'
import { collab } from '@/state/collab'

/**
 * Save/open orchestration. The .sdaw container is a ZIP of project.json
 * plus each referenced asset's original bytes (see core/persistence).
 * Uses the Electron bridge when present; in browser dev mode it falls back
 * to a download link (save) and a file picker (open).
 */

export async function packProject(): Promise<Uint8Array> {
  const state = projectStore.state
  const referenced = referencedAssetIds(state)
  const manifest: AssetManifestEntry[] = []
  const archive: Record<string, Uint8Array> = {}

  for (const asset of assetStore.all()) {
    if (!referenced.has(asset.id)) continue // GC unreferenced assets on save
    const entry: AssetManifestEntry = {
      id: asset.id,
      name: asset.name,
      kind: asset.kind,
      ext: asset.ext
    }
    manifest.push(entry)
    archive[assetPathInArchive(entry)] = asset.encoded
  }
  archive['project.json'] = strToU8(
    serializeProjectJson(state, manifest, projectStore.lineage, projectStore.opLog)
  )
  // Audio payloads are already compressed formats; level 0 keeps saves
  // fast. The async zip runs in fflate's worker, so the per-entry CRC32
  // pass over hundreds of MB of assets no longer freezes the UI on Ctrl+S.
  return new Promise((resolve, reject) => {
    zip(archive, { level: 0 }, (error, data) => {
      if (error) reject(error)
      else resolve(data)
    })
  })
}

async function parseArchive(data: Uint8Array): Promise<{
  archive: Record<string, Uint8Array>
  parsed: ReturnType<typeof parseProjectJson>
}> {
  // Worker-backed unzip for the same reason packProject uses zip().
  const archive = await new Promise<Record<string, Uint8Array>>((resolve, reject) => {
    unzip(data, (error, files) => {
      if (error) reject(error)
      else resolve(files)
    })
  })
  const projectJson = archive['project.json']
  if (!projectJson) throw new Error('Not a SuperDAW project file (missing project.json)')
  return { archive, parsed: parseProjectJson(strFromU8(projectJson)) }
}

interface DecodedAsset {
  entry: AssetManifestEntry
  bytes: Uint8Array
  buffer: AudioBuffer | null
  /** Audio whose bytes survived but would not decode (see failedDecodes). */
  failed: boolean
}

/**
 * Decode archive assets WITHOUT touching the store. Decoding a big project
 * can fail part-way (an allocation failure under memory pressure is the
 * usual cause), so nothing is committed until every asset is in hand —
 * otherwise a half-finished open would leave the app holding neither the
 * old project's audio nor the new one's, which reads as "all my audio
 * disappeared". `skipExisting` keeps assets we already hold (merge path).
 */
async function decodeArchiveAssets(
  archive: Record<string, Uint8Array>,
  assets: AssetManifestEntry[],
  { skipExisting }: { skipExisting: boolean }
): Promise<DecodedAsset[]> {
  // decodeAudioData does its work off-thread, so decoding a few assets
  // concurrently is nearly free wall-clock savings; the pool bound keeps
  // peak memory in check for very large projects.
  const CONCURRENCY = 4
  const pending = assets.filter((entry) => !(skipExisting && assetStore.get(entry.id)))
  const decoded: Array<DecodedAsset | null> = new Array(pending.length).fill(null)
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < pending.length) {
      const index = next++
      const entry = pending[index]
      const bytes = archive[assetPathInArchive(entry)]
      if (!bytes) {
        console.warn(`Project file is missing asset "${entry.name}" (${entry.id})`)
        continue
      }
      let buffer: AudioBuffer | null = null
      let failed = false
      if (entry.kind === 'audio') {
        try {
          buffer = await audioEngine.decode(bytes.slice().buffer)
        } catch (error) {
          console.error(`Could not decode asset "${entry.name}"`, error)
          failed = true
        }
      }
      decoded[index] = { entry, bytes, buffer, failed }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, pending.length) }, () => worker())
  )
  return decoded.filter((d): d is DecodedAsset => d !== null)
}

function registerDecodedAssets(decoded: DecodedAsset[]): void {
  for (const { entry, bytes, buffer } of decoded) {
    assetStore.restore(entry.id, entry.name, entry.kind, entry.ext, bytes, buffer)
  }
}

export async function loadProjectBytes(data: Uint8Array, path: string | null): Promise<void> {
  const { archive, parsed } = await parseArchive(data)
  const { state, assets, lineage, opLog } = parsed

  // Decode first, swap second: until this resolves the current project is
  // untouched, so a failure aborts the open instead of emptying the store.
  const decoded = await decodeArchiveAssets(archive, assets, { skipExisting: false })

  transport.stop()
  selection.select(null)
  // Never carry a live input into another project's tracks.
  void trackInputs.stopAllMonitors()
  assetStore.clear()
  registerDecodedAssets(decoded)

  projectStore.loadProject(state, lineage, opLog)
  transport.setPosition(0)
  sessionFile.markLoaded(path)
  recentProjects.record(state, path)

  const failed = decoded.filter((d) => d.failed).length
  if (failed > 0) {
    window.alert(
      `${failed} audio file${failed === 1 ? '' : 's'} in this project could not be decoded and ` +
        `will play silent. The file itself is intact — reopening after freeing memory may fix it.`
    )
  }
}

function defaultFileName(): string {
  const base = projectStore.state.name.trim() || 'Untitled'
  return `${base}.${PROJECT_FILE_EXTENSION}`
}

/**
 * Save. `forceDialog` = "Save As". Resolves when done (or cancelled).
 *
 * Never fails quietly: packing a large project allocates the whole archive
 * contiguously, so it CAN throw under memory pressure, and a save the user
 * believes succeeded is how a session's work gets lost.
 */
export async function saveProject(forceDialog = false): Promise<void> {
  try {
    const data = await packProject()
    const bridge = window.superdaw
    if (bridge) {
      const path = await bridge.saveProjectFile({
        data,
        path: forceDialog ? null : sessionFile.path,
        defaultName: defaultFileName()
      })
      if (path !== null) {
        sessionFile.markSaved(path)
        recentProjects.record(projectStore.state, path)
      }
      return
    }
    // Browser fallback: download. No stable path, so every save re-downloads.
    const url = URL.createObjectURL(new Blob([data.buffer as ArrayBuffer]))
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = defaultFileName()
    anchor.click()
    // Revoking synchronously races the download the click just started and
    // truncates large archives; let it begin first.
    setTimeout(() => URL.revokeObjectURL(url), 60_000)
    sessionFile.markSaved(null)
    recentProjects.record(projectStore.state, null)
  } catch (error) {
    // Deliberately not rethrown: every caller fires this and forgets. The
    // failure is still legible downstream because markSaved() never ran, so
    // the project stays dirty and the close guard keeps the window open.
    console.error('Save failed', error)
    window.alert(
      `Could not save the project — it has NOT been written to disk.\n\n${
        error instanceof Error ? error.message : String(error)
      }`
    )
  }
}

/** Start an empty project. Asks before discarding unsaved changes. */
export function newProject(): void {
  // Wiping the document out from under a live session desyncs every peer
  // (their ops still target the old project). Central guard: every entry
  // point — menu, palette, shortcut — lands here.
  if (collab.mode !== 'off') {
    window.alert(
      'Leave the collaboration session first — a new project cannot replace the document a running session is syncing.'
    )
    return
  }
  if (
    sessionFile.dirty &&
    !window.confirm('Discard unsaved changes and start a new project?')
  ) {
    return
  }
  transport.stop()
  transport.setPosition(0)
  selection.select(null)
  pianoRollUi.close()
  void trackInputs.stopAllMonitors()
  assetStore.clear()
  projectStore.loadProject(createEmptyProject('Untitled', Date.now()))
  sessionFile.markLoaded(null)
  appShell.enterProject()
}

/**
 * Discard the current document and return to the home screen. Asks before
 * discarding unsaved changes; returns false if the user cancelled.
 */
export function closeProject(skipConfirm = false): boolean {
  // The Exit button asks its own save/discard question first; everything
  // else still gets the safety net.
  if (
    !skipConfirm &&
    sessionFile.dirty &&
    !window.confirm('Discard unsaved changes and close the project?')
  ) {
    return false
  }
  transport.stop()
  transport.setPosition(0)
  selection.select(null)
  pianoRollUi.close()
  void trackInputs.stopAllMonitors()
  assetStore.clear()
  projectStore.loadProject(createEmptyProject('Untitled'))
  sessionFile.markLoaded(null)
  appShell.markProjectClosed()
  return true
}

/**
 * Offline-render the whole project to a stereo 16-bit WAV and save it.
 * Rendering happens faster than realtime in an OfflineAudioContext.
 */
export async function exportWav(): Promise<void> {
  const data = await renderMixdown(projectStore.state, assetStore)
  if (!data) return // empty project — nothing to bounce
  const name = `${projectStore.state.name.trim() || 'Untitled'}.wav`
  const bridge = window.superdaw
  if (bridge) {
    await bridge.exportFile({ data, defaultName: name, filterName: 'WAV audio', ext: 'wav' })
    return
  }
  const url = URL.createObjectURL(new Blob([data.buffer as ArrayBuffer]))
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = name
  anchor.click()
  URL.revokeObjectURL(url)
}

export async function openProject(): Promise<void> {
  // Same guard as newProject: replacing the synced document breaks peers.
  if (collab.mode !== 'off') {
    window.alert(
      'Leave the collaboration session first — opening a project cannot replace the document a running session is syncing.'
    )
    return
  }
  const bridge = window.superdaw
  if (bridge) {
    const result = await bridge.openProjectFile()
    if (result) {
      await loadProjectBytes(result.data, result.path)
      appShell.enterProject()
    }
    return
  }
  // Browser fallback: file picker.
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = `.${PROJECT_FILE_EXTENSION}`
  input.onchange = async () => {
    const file = input.files?.[0]
    if (file) {
      await loadProjectBytes(new Uint8Array(await file.arrayBuffer()), null)
      appShell.enterProject()
    }
  }
  input.click()
}

/**
 * Open an entry from the recent-projects index. Entries without a path
 * (browser saves) fall back to the picker; entries whose file is gone are
 * pruned from the index.
 */
export async function openRecentProject(entry: RecentProject): Promise<void> {
  if (collab.mode !== 'off') {
    window.alert(
      'Leave the collaboration session first — opening a project cannot replace the document a running session is syncing.'
    )
    return
  }
  const bridge = window.superdaw
  if (!entry.path || !bridge) {
    await openProject()
    return
  }
  const result = await bridge.openProjectPath(entry.path)
  if (!result) {
    recentProjects.remove(entry)
    window.alert(`"${entry.name}" could not be opened — the file has moved or been deleted.`)
    return
  }
  await loadProjectBytes(result.data, result.path)
  appShell.enterProject()
}

/**
 * Merge a saved copy of THIS project (same lineage id) into the open
 * document: assets the copy has and we lack are imported, then both op
 * histories replay chronologically from the shared origin — every field
 * ends up at whichever copy's change is newest (core/merge). The result
 * is unsaved; Save writes the merged project with its merged history.
 */
export async function mergeProjectBytes(data: Uint8Array): Promise<void> {
  const { archive, parsed } = await parseArchive(data)
  if (!parsed.lineage) {
    throw new Error('That file has no edit history to merge (saved before merge support).')
  }
  const ours = { lineage: projectStore.lineage, log: projectStore.opLog }
  const theirs = { lineage: parsed.lineage, log: parsed.opLog ?? [] }
  if (!canMerge(ours, theirs)) {
    throw new Error('That file is a different project, not a copy of this one.')
  }

  transport.stop()
  selection.select(null)
  pianoRollUi.close()
  // Additive: keeps what we already have, so decode-then-register needs no
  // staging here — nothing is cleared.
  registerDecodedAssets(await decodeArchiveAssets(archive, parsed.assets, { skipExisting: true }))

  const merged = mergeForks(ours, theirs)
  projectStore.loadProject(merged.state, merged.lineage, merged.log)
  sessionFile.markDirty()
}

/** File-picker front end for `mergeProjectBytes`. Reports errors inline. */
export async function mergeProjectFromFile(): Promise<void> {
  const merge = async (data: Uint8Array): Promise<void> => {
    try {
      await mergeProjectBytes(data)
    } catch (error) {
      window.alert(error instanceof Error ? error.message : 'Merge failed.')
    }
  }
  const bridge = window.superdaw
  if (bridge) {
    const result = await bridge.openProjectFile()
    if (result) await merge(result.data)
    return
  }
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = `.${PROJECT_FILE_EXTENSION}`
  input.onchange = async () => {
    const file = input.files?.[0]
    if (file) await merge(new Uint8Array(await file.arrayBuffer()))
  }
  input.click()
}
