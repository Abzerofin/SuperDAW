import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'
import {
  assetPathInArchive,
  parseProjectJson,
  PROJECT_FILE_EXTENSION,
  referencedAssetIds,
  serializeProjectJson,
  type AssetManifestEntry
} from '@core/persistence/format'
import { createEmptyProject } from '@core/model/types'
import { renderMixdown } from '@audio/render'
import { projectStore } from '@/state/projectStore'
import { assetStore, audioEngine } from '@/state/audioInstance'
import { transport } from '@/state/transport'
import { selection } from '@/state/selection'
import { sessionFile } from '@/state/sessionFile'
import { pianoRollUi } from '@/state/pianoRollUi'

/**
 * Save/open orchestration. The .sdaw container is a ZIP of project.json
 * plus each referenced asset's original bytes (see core/persistence).
 * Uses the Electron bridge when present; in browser dev mode it falls back
 * to a download link (save) and a file picker (open).
 */

export function packProject(): Uint8Array {
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
  archive['project.json'] = strToU8(serializeProjectJson(state, manifest))
  // Audio payloads are already compressed formats; level 0 keeps saves fast.
  return zipSync(archive, { level: 0 })
}

export async function loadProjectBytes(data: Uint8Array, path: string | null): Promise<void> {
  const archive = unzipSync(data)
  const projectJson = archive['project.json']
  if (!projectJson) throw new Error('Not a SuperDAW project file (missing project.json)')
  const { state, assets } = parseProjectJson(strFromU8(projectJson))

  transport.stop()
  selection.select(null)
  assetStore.clear()

  for (const entry of assets) {
    const bytes = archive[assetPathInArchive(entry)]
    if (!bytes) {
      console.warn(`Project file is missing asset "${entry.name}" (${entry.id})`)
      continue
    }
    let buffer: AudioBuffer | null = null
    if (entry.kind === 'audio') {
      try {
        buffer = await audioEngine.decode(bytes.slice().buffer)
      } catch (error) {
        console.error(`Could not decode asset "${entry.name}"`, error)
      }
    }
    assetStore.restore(entry.id, entry.name, entry.kind, entry.ext, bytes, buffer)
  }

  projectStore.loadProject(state)
  transport.setPosition(0)
  sessionFile.markLoaded(path)
}

function defaultFileName(): string {
  const base = projectStore.state.name.trim() || 'Untitled'
  return `${base}.${PROJECT_FILE_EXTENSION}`
}

/** Save. `forceDialog` = "Save As". Resolves when done (or cancelled). */
export async function saveProject(forceDialog = false): Promise<void> {
  const data = packProject()
  const bridge = window.superdaw
  if (bridge) {
    const path = await bridge.saveProjectFile({
      data,
      path: forceDialog ? null : sessionFile.path,
      defaultName: defaultFileName()
    })
    if (path !== null) sessionFile.markSaved(path)
    return
  }
  // Browser fallback: download. No stable path, so every save re-downloads.
  const url = URL.createObjectURL(new Blob([data.buffer as ArrayBuffer]))
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = defaultFileName()
  anchor.click()
  URL.revokeObjectURL(url)
  sessionFile.markSaved(null)
}

/** Start an empty project. Asks before discarding unsaved changes. */
export function newProject(): void {
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
  assetStore.clear()
  projectStore.loadProject(createEmptyProject('Untitled'))
  sessionFile.markLoaded(null)
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
  const bridge = window.superdaw
  if (bridge) {
    const result = await bridge.openProjectFile()
    if (result) await loadProjectBytes(result.data, result.path)
    return
  }
  // Browser fallback: file picker.
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = `.${PROJECT_FILE_EXTENSION}`
  input.onchange = async () => {
    const file = input.files?.[0]
    if (file) await loadProjectBytes(new Uint8Array(await file.arrayBuffer()), null)
  }
  input.click()
}
