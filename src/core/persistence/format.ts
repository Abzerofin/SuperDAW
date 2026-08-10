import type { Clip, PluginInstance, ProjectState, Track } from '../model/types'
import { createEmptyProject } from '../model/types'
import { routeIsValid } from '../model/routing'
import { synthDefaults, EFFECT_DEFS, type EffectType } from '../model/effects'
import { builtinEffectDescriptor } from '../plugins/builtin'
import type { OpEnvelope } from '../ops/operations'
import type { ProjectLineage } from '../state/store'

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

/**
 * 2: insert chain became plugin instances with descriptors (was `effects` keyed by EffectType).
 * 3: project lineage (stable projectId + origin snapshot) and the trailing
 *    op log, enabling offline copies of one project to merge (core/merge).
 */
export const FORMAT_VERSION = 3
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
  /** Absent in pre-v3 files — the app mints a fresh lineage on load. */
  readonly lineage?: ProjectLineage
  readonly opLog?: OpEnvelope[]
}

export function assetPathInArchive(entry: AssetManifestEntry): string {
  return `assets/${entry.id}.${entry.ext}`
}

/** Asset ids referenced by the document (clips, bay entries, frozen tracks). */
export function referencedAssetIds(state: ProjectState): Set<string> {
  const ids = new Set<string>()
  for (const clip of Object.values(state.clips)) {
    if (clip.assetId) ids.add(clip.assetId)
  }
  for (const node of Object.values(state.files)) {
    if (node.assetId) ids.add(node.assetId)
  }
  for (const track of Object.values(state.tracks)) {
    if (track.frozenAssetId) ids.add(track.frozenAssetId)
  }
  return ids
}

export function serializeProjectJson(
  state: ProjectState,
  assets: AssetManifestEntry[],
  lineage?: ProjectLineage,
  opLog?: readonly OpEnvelope[]
): string {
  const json: ProjectFileJson = {
    formatVersion: FORMAT_VERSION,
    state,
    assets,
    ...(lineage ? { lineage, opLog: [...(opLog ?? [])] } : {})
  }
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

  const full = normalizeState(state as unknown as ProjectState)
  const lineage = parseLineage(candidate.lineage)
  const opLog = parseOpLog(candidate.opLog)
  return {
    formatVersion: candidate.formatVersion,
    state: full,
    assets,
    ...(lineage ? { lineage } : {}),
    ...(opLog ? { opLog } : {})
  }
}

/**
 * Migrate a raw saved state to the current shape. Merge over an empty
 * project so top-level fields added in later app versions get defaults,
 * then normalize per-track fields the same way (a v1 file from before the
 * mixer has no volume/pan on its tracks). Applied to the document AND to
 * the lineage origin snapshot — both replay through the current reducer.
 */
function normalizeState(state: ProjectState): ProjectState {
  const merged: ProjectState = { ...createEmptyProject(''), ...state }
  const tracks: Record<string, Track> = {}
  for (const [id, track] of Object.entries(merged.tracks)) {
    const legacy = track as Omit<Track, 'volume' | 'pan' | 'synth'> & Partial<Track>
    tracks[id] = {
      ...legacy,
      volume: legacy.volume ?? 1,
      pan: legacy.pan ?? 0,
      synth: legacy.synth ?? (legacy.kind === 'midi' ? synthDefaults() : {}),
      // Pre-folder/freeze files: root-level, unfrozen.
      parentId: legacy.parentId ?? null,
      frozenAssetId: legacy.frozenAssetId ?? null
    }
  }
  // Clips from before fades/playback settings lack those fields. Files from
  // the era of the boolean `loop` flag carry the same period semantics in
  // `loopLength`, so an enabled loop survives; a disabled one becomes 0.
  const clips: Record<string, Clip> = {}
  for (const [id, clip] of Object.entries(merged.clips)) {
    const { loop: legacyLoopFlag, ...rest } = clip as Clip & { loop?: boolean }
    const legacy = rest as Omit<
      Clip,
      'fadeIn' | 'fadeOut' | 'reverse' | 'pitch' | 'stretch' | 'loopLength'
    > &
      Partial<Clip>
    clips[id] = {
      ...legacy,
      fadeIn: legacy.fadeIn ?? 0,
      fadeOut: legacy.fadeOut ?? 0,
      reverse: legacy.reverse ?? false,
      pitch: legacy.pitch ?? 0,
      stretch: legacy.stretch ?? 1,
      loopLength: legacyLoopFlag === false ? 0 : (legacy.loopLength ?? 0)
    }
  }
  const full: ProjectState = { ...merged, tracks, clips, plugins: migratePlugins(merged) }
  // v1 stored inserts under `effects`; migratePlugins consumed it.
  delete (full as { effects?: unknown }).effects
  return sanitizeRoutes(full)
}

/**
 * Routing edges come straight from the file, so each one re-earns its
 * place through the same validator the reducer uses — malformed shapes,
 * dangling endpoints, duplicates and cycles are dropped, never trusted.
 * (Additive since format 3; older files simply have none.)
 */
function sanitizeRoutes(state: ProjectState): ProjectState {
  const stored = Object.values(state.routes ?? {})
  // `routes` is mutated in place while `acc` keeps referencing it, so each
  // edge is validated against the evolving accepted set (duplicate/cycle
  // checks) without rebuilding the state object per route.
  const routes: Record<string, (typeof stored)[number]> = {}
  const acc: ProjectState = { ...state, routes }
  for (const route of stored) {
    if (
      typeof route?.id !== 'string' ||
      typeof route.trackId !== 'string' ||
      typeof route.from !== 'string' ||
      typeof route.to !== 'string'
    ) {
      continue
    }
    if (!routeIsValid(acc, route)) continue
    routes[route.id] = route
  }
  return acc
}

/** Lineage is best-effort: anything malformed → undefined (fresh lineage on load). */
function parseLineage(raw: unknown): ProjectLineage | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const candidate = raw as Record<string, unknown>
  if (
    typeof candidate.projectId !== 'string' ||
    typeof candidate.originTime !== 'number' ||
    typeof candidate.origin !== 'object' ||
    candidate.origin === null
  ) {
    return undefined
  }
  return {
    projectId: candidate.projectId,
    originTime: candidate.originTime,
    origin: normalizeState(candidate.origin as ProjectState)
  }
}

function parseOpLog(raw: unknown): OpEnvelope[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const log: OpEnvelope[] = []
  for (const entry of raw as Array<Record<string, unknown>>) {
    if (
      typeof entry !== 'object' ||
      entry === null ||
      typeof entry.id !== 'string' ||
      typeof entry.userId !== 'string' ||
      typeof entry.time !== 'number' ||
      typeof entry.op !== 'object' ||
      entry.op === null
    ) {
      return undefined // a corrupt log is useless for merging — drop it whole
    }
    log.push(entry as unknown as OpEnvelope)
  }
  return log
}

interface LegacyEffect {
  readonly id: string
  readonly trackId: string
  readonly type: EffectType
  readonly enabled?: boolean
  readonly rank?: number
  readonly params?: Record<string, number>
}

/**
 * v1 inserts were `effects` records identified by a bare EffectType; they
 * become plugin instances with builtin descriptors. v2+ instances pass
 * through with `stateBlob` defaulted for forward compatibility.
 */
function migratePlugins(merged: ProjectState): Record<string, PluginInstance> {
  const plugins: Record<string, PluginInstance> = {}
  for (const [id, instance] of Object.entries(merged.plugins ?? {})) {
    plugins[id] = { ...instance, stateBlob: instance.stateBlob ?? null }
  }
  const legacy = (merged as { effects?: Record<string, LegacyEffect> }).effects
  if (legacy) {
    for (const [id, fx] of Object.entries(legacy)) {
      if (plugins[id] || !EFFECT_DEFS[fx.type]) continue
      plugins[id] = {
        id,
        trackId: fx.trackId,
        descriptor: builtinEffectDescriptor(fx.type),
        enabled: fx.enabled ?? true,
        rank: fx.rank ?? 1,
        params: fx.params ?? {},
        stateBlob: null
      }
    }
  }
  return plugins
}
