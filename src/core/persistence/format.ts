import type { ProjectState, Track } from '../model/types'
import { createEmptyProject } from '../model/types'
import { synthDefaults } from '../model/effects'

/**
 * The .sdaw project file is a ZIP archive:
 *
 *   project.json          document state + asset manifest (this module)
 *   assets/<id>.<ext>     original encoded bytes of each asset
 *
 * This module handles only the JSON layer — pure and dependency-free so the
 * format is testable and, later, reusable by the collaboration layer for
 * snapshot transfer. Zipping and binary handling live with the app shell.
 *
 * Only assets still referenced by a clip or a File Bay entry are listed in
 * the manifest; anything else (e.g. kept alive solely by the undo stack)
 * is garbage-collected at save time.
 */

export const FORMAT_VERSION = 1
export const PROJECT_FILE_EXTENSION = 'sdaw'

export interface AssetManifestEntry {
  readonly id: string
  readonly name: string
  readonly kind: 'audio' | 'midi'
  /** Original file extension, e.g. "wav" — names the archive entry. */
  readonly ext: string
}

export interface ProjectFileJson {
  readonly formatVersion: number
  readonly state: ProjectState
  readonly assets: AssetManifestEntry[]
}

export function assetPathInArchive(entry: AssetManifestEntry): string {
  return `assets/${entry.id}.${entry.ext}`
}

/** Asset ids referenced by the document (clips or bay entries). */
export function referencedAssetIds(state: ProjectState): Set<string> {
  const ids = new Set<string>()
  for (const clip of Object.values(state.clips)) {
    if (clip.assetId) ids.add(clip.assetId)
  }
  for (const node of Object.values(state.files)) {
    if (node.assetId) ids.add(node.assetId)
  }
  return ids
}

export function serializeProjectJson(state: ProjectState, assets: AssetManifestEntry[]): string {
  const json: ProjectFileJson = { formatVersion: FORMAT_VERSION, state, assets }
  return JSON.stringify(json)
}

/** Parse and structurally validate project.json. Throws on anything unusable. */
export function parseProjectJson(text: string): ProjectFileJson {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw new Error('Project file is corrupted (invalid JSON)')
  }
  if (typeof raw !== 'object' || raw === null) throw new Error('Project file is corrupted')
  const candidate = raw as Record<string, unknown>

  if (typeof candidate.formatVersion !== 'number') throw new Error('Project file is corrupted')
  if (candidate.formatVersion > FORMAT_VERSION) {
    throw new Error(
      `This project was saved by a newer version of SuperDAW (format ${candidate.formatVersion})`
    )
  }

  const state = candidate.state as Record<string, unknown> | undefined
  if (
    !state ||
    typeof state.name !== 'string' ||
    typeof state.tempo !== 'number' ||
    !Array.isArray(state.timeSignature) ||
    typeof state.tracks !== 'object' ||
    !Array.isArray(state.trackOrder) ||
    typeof state.clips !== 'object' ||
    typeof state.files !== 'object'
  ) {
    throw new Error('Project file is corrupted (unexpected structure)')
  }

  const assets = Array.isArray(candidate.assets) ? (candidate.assets as AssetManifestEntry[]) : []
  for (const entry of assets) {
    if (
      typeof entry.id !== 'string' ||
      typeof entry.name !== 'string' ||
      typeof entry.ext !== 'string' ||
      (entry.kind !== 'audio' && entry.kind !== 'midi')
    ) {
      throw new Error('Project file is corrupted (bad asset manifest)')
    }
  }

  // Merge over an empty project so top-level fields added in later app
  // versions get defaults, then normalize per-track fields the same way
  // (a v1 file from before the mixer has no volume/pan on its tracks).
  const merged: ProjectState = { ...createEmptyProject(''), ...(state as unknown as ProjectState) }
  const tracks: Record<string, Track> = {}
  for (const [id, track] of Object.entries(merged.tracks)) {
    const legacy = track as Omit<Track, 'volume' | 'pan' | 'synth'> & Partial<Track>
    tracks[id] = {
      ...legacy,
      volume: legacy.volume ?? 1,
      pan: legacy.pan ?? 0,
      synth: legacy.synth ?? (legacy.kind === 'midi' ? synthDefaults() : {})
    }
  }
  const full: ProjectState = { ...merged, tracks }
  return { formatVersion: candidate.formatVersion, state: full, assets }
}
