import type {
  PluginInstance,
  ProjectState,
  Route,
  Track,
  TrackKind
} from '../model/types'
import { createEmptyProject, MAX_GAIN, pluginsOfTrack, routesOfTrack } from '../model/types'
import { newId } from '../model/ids'
import { SYNTH_DEFS, clampParam, synthDefaults } from '../model/effects'
import { isPluginDescriptor, type PluginDescriptor } from '../plugins/descriptor'
import { paramDefsOf } from '../plugins/builtin'
import { normalizeProjectSettings, type ProjectSettings } from '../model/projectSettings'
import type { TimeSignature } from '../model/timebase'

/**
 * Session templates: a portable JSON file carrying a project's SETUP —
 * track tree (with mixer, synth and full insert chains by descriptor),
 * routing graphs, tempo/signature and the project settings — without any
 * CONTENT (no clips, notes, files, chat, comments, automation, assets).
 *
 * "New from template" then materializes a fresh ProjectState with fresh
 * ids (a template instantiated twice must never mint colliding entities,
 * the same rule that keeps duplicate-track a fully-materialized create).
 * Like track presets, templates carry descriptors and stateBlobs, never
 * filesystem paths, and are validated field-by-field like the project
 * format — a doctored template clamps instead of smuggling bad values.
 */

export const PROJECT_TEMPLATE_VERSION = 1
export const PROJECT_TEMPLATE_EXTENSION = 'sdtpl'

export interface TemplateTrack {
  /** Template-local id — replaced by a fresh id at instantiation. */
  readonly id: string
  readonly parentId: string | null
  readonly kind: TrackKind
  readonly name: string
  readonly color: string
  readonly volume: number
  readonly pan: number
  readonly synth: Readonly<Record<string, number>>
}

export interface TemplatePlugin {
  /** Template-local id, referenced by routes; replaced at instantiation. */
  readonly id: string
  readonly trackId: string
  readonly descriptor: PluginDescriptor
  readonly enabled: boolean
  readonly rank: number
  readonly params: Readonly<Record<string, number>>
  readonly stateBlob: string | null
}

export interface TemplateRoute {
  readonly trackId: string
  readonly from: 'in' | string
  readonly to: 'out' | string
}

export interface ProjectTemplateJson {
  readonly kind: 'superdaw-project-template'
  readonly formatVersion: number
  readonly name: string
  readonly tempo: number
  readonly timeSignature: TimeSignature
  readonly masterVolume: number
  readonly settings: ProjectSettings
  /** In trackOrder order — instantiation preserves the visible ordering. */
  readonly tracks: readonly TemplateTrack[]
  readonly plugins: readonly TemplatePlugin[]
  readonly routes: readonly TemplateRoute[]
}

/** Capture the open project's setup as a template file. */
export function serializeProjectTemplate(state: ProjectState, templateName: string): string {
  const tracks: TemplateTrack[] = []
  const plugins: TemplatePlugin[] = []
  const routes: TemplateRoute[] = []
  for (const trackId of state.trackOrder) {
    const track = state.tracks[trackId]
    if (!track) continue
    tracks.push({
      id: track.id,
      parentId: track.parentId,
      kind: track.kind,
      name: track.name,
      color: track.color,
      volume: track.volume,
      pan: track.pan,
      synth: track.synth
    })
    for (const plugin of pluginsOfTrack(state, trackId)) {
      plugins.push({
        id: plugin.id,
        trackId: track.id,
        descriptor: plugin.descriptor,
        enabled: plugin.enabled,
        rank: plugin.rank,
        params: plugin.params,
        stateBlob: plugin.stateBlob
      })
    }
    for (const route of routesOfTrack(state, trackId)) {
      routes.push({ trackId: track.id, from: route.from, to: route.to })
    }
  }
  const template: ProjectTemplateJson = {
    kind: 'superdaw-project-template',
    formatVersion: PROJECT_TEMPLATE_VERSION,
    name: templateName.trim() || 'Template',
    tempo: state.tempo,
    timeSignature: state.timeSignature,
    masterVolume: state.masterVolume,
    settings: state.settings,
    tracks,
    plugins,
    routes
  }
  return JSON.stringify(template, null, 2)
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function sanitizeNumbers(raw: unknown): Record<string, number> {
  const out: Record<string, number> = {}
  if (typeof raw !== 'object' || raw === null) return out
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === 'number' && Number.isFinite(value)) out[key] = value
  }
  return out
}

function sanitizeTimeSignature(raw: unknown): TimeSignature {
  if (Array.isArray(raw) && raw.length === 2) {
    const [num, den] = raw
    if (
      typeof num === 'number' &&
      Number.isInteger(num) &&
      num >= 1 &&
      num <= 32 &&
      [1, 2, 4, 8, 16, 32].includes(den as number)
    ) {
      return [num, den as number] as TimeSignature
    }
  }
  return [4, 4]
}

/** Parse and validate a template file. Throws on anything unusable. */
export function parseProjectTemplate(text: string): ProjectTemplateJson {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw new Error('Template file is corrupted (invalid JSON)')
  }
  const t = raw as Record<string, unknown>
  if (typeof t !== 'object' || t === null || t.kind !== 'superdaw-project-template') {
    throw new Error('Not a SuperDAW project template')
  }
  if (typeof t.formatVersion !== 'number' || t.formatVersion > PROJECT_TEMPLATE_VERSION) {
    throw new Error('This template was saved by a newer version of SuperDAW')
  }

  const trackIds = new Set<string>()
  const tracks: TemplateTrack[] = (Array.isArray(t.tracks) ? t.tracks : [])
    .filter((entry: unknown) => {
      const track = entry as Record<string, unknown> | null
      return (
        typeof track === 'object' &&
        track !== null &&
        typeof track.id === 'string' &&
        ['audio', 'midi', 'folder'].includes(track.kind as string)
      )
    })
    .map((entry: Record<string, unknown>, i: number) => {
      const kind = entry.kind as TrackKind
      const synth: Record<string, number> = {}
      if (kind === 'midi') {
        const rawSynth = sanitizeNumbers(entry.synth)
        for (const [key, def] of Object.entries(SYNTH_DEFS)) {
          synth[key] = clampParam(def, rawSynth[key] ?? def.default)
        }
      }
      return {
        id: entry.id as string,
        parentId: typeof entry.parentId === 'string' ? entry.parentId : null,
        kind,
        name:
          typeof entry.name === 'string' && entry.name.trim() ? entry.name : `Track ${i + 1}`,
        color: typeof entry.color === 'string' ? entry.color : '#5b8def',
        volume: clamp(typeof entry.volume === 'number' ? entry.volume : 1, 0, MAX_GAIN),
        pan: clamp(typeof entry.pan === 'number' ? entry.pan : 0, -1, 1),
        synth
      }
    })
    // Duplicate template-local ids would make parent/plugin references
    // ambiguous — first occurrence wins, exactly like the reducer's rule.
    .filter((track) => (trackIds.has(track.id) ? false : (trackIds.add(track.id), true)))

  // A parent link must point at a folder track that survived validation.
  const folderIds = new Set(tracks.filter((track) => track.kind === 'folder').map((t2) => t2.id))
  const parented = tracks.map((track) =>
    track.parentId !== null && (!folderIds.has(track.parentId) || track.parentId === track.id)
      ? { ...track, parentId: null }
      : track
  )

  const pluginIds = new Set<string>()
  const plugins: TemplatePlugin[] = (Array.isArray(t.plugins) ? t.plugins : [])
    .filter((entry: unknown) => {
      const plugin = entry as Record<string, unknown> | null
      return (
        typeof plugin === 'object' &&
        plugin !== null &&
        isPluginDescriptor(plugin.descriptor) &&
        typeof plugin.trackId === 'string' &&
        trackIds.has(plugin.trackId)
      )
    })
    .map((entry: Record<string, unknown>, i: number) => {
      const descriptor = entry.descriptor as PluginDescriptor
      const defs = paramDefsOf(descriptor)
      const rawParams = sanitizeNumbers(entry.params)
      const params: Record<string, number> = {}
      if (defs) {
        for (const [key, def] of Object.entries(defs)) {
          params[key] = clampParam(def, rawParams[key] ?? def.default)
        }
      } else {
        Object.assign(params, rawParams)
      }
      return {
        id: typeof entry.id === 'string' ? entry.id : `plugin-${i}`,
        trackId: entry.trackId as string,
        descriptor,
        enabled: entry.enabled !== false,
        rank: typeof entry.rank === 'number' ? entry.rank : i + 1,
        params,
        stateBlob: typeof entry.stateBlob === 'string' ? entry.stateBlob : null
      }
    })
    // Builtin descriptors core doesn't know are unusable (reducer would drop them).
    .filter(
      (entry) => entry.descriptor.format !== 'builtin' || paramDefsOf(entry.descriptor) !== null
    )
    .filter((plugin) => (pluginIds.has(plugin.id) ? false : (pluginIds.add(plugin.id), true)))

  const endpointOk = (pluginId: string, trackId: string): boolean => {
    const plugin = plugins.find((p) => p.id === pluginId)
    return plugin !== undefined && plugin.trackId === trackId
  }
  const routes: TemplateRoute[] = (Array.isArray(t.routes) ? t.routes : [])
    .filter((entry: unknown) => {
      const route = entry as Record<string, unknown> | null
      if (typeof route !== 'object' || route === null) return false
      const { trackId, from, to } = route
      if (typeof trackId !== 'string' || !trackIds.has(trackId)) return false
      if (typeof from !== 'string' || typeof to !== 'string') return false
      if (from !== 'in' && !endpointOk(from, trackId)) return false
      if (to !== 'out' && !endpointOk(to, trackId)) return false
      return true
    })
    .map((entry: Record<string, unknown>) => ({
      trackId: entry.trackId as string,
      from: entry.from as 'in' | string,
      to: entry.to as 'out' | string
    }))

  return {
    kind: 'superdaw-project-template',
    formatVersion: t.formatVersion,
    name: typeof t.name === 'string' && t.name.trim() ? t.name : 'Template',
    tempo: clamp(typeof t.tempo === 'number' && Number.isFinite(t.tempo) ? t.tempo : 120, 20, 400),
    timeSignature: sanitizeTimeSignature(t.timeSignature),
    masterVolume: clamp(
      typeof t.masterVolume === 'number' && Number.isFinite(t.masterVolume) ? t.masterVolume : 1,
      0,
      MAX_GAIN
    ),
    settings: normalizeProjectSettings(t.settings),
    tracks: parented,
    plugins,
    routes
  }
}

/**
 * Materialize a template as a brand-new ProjectState with FRESH ids for
 * every track, plugin and route. The caller loads the result through
 * `ProjectStore.loadProject` (like open) — creating a project is not an
 * operation, so nothing here mints ops.
 */
export function projectFromTemplate(
  template: ProjectTemplateJson,
  projectName: string,
  createdAt: number
): ProjectState {
  const base = createEmptyProject(projectName.trim() || template.name, createdAt)

  const trackIdMap = new Map<string, string>()
  for (const track of template.tracks) trackIdMap.set(track.id, newId('trk'))

  const tracks: Record<string, Track> = {}
  const trackOrder: string[] = []
  for (const track of template.tracks) {
    const id = trackIdMap.get(track.id)!
    tracks[id] = {
      id,
      kind: track.kind,
      name: track.name,
      color: track.color,
      muted: false,
      soloed: false,
      parentId: track.parentId !== null ? (trackIdMap.get(track.parentId) ?? null) : null,
      frozenAssetId: null,
      volume: track.volume,
      pan: track.pan,
      synth: track.kind === 'midi' ? { ...synthDefaults(), ...track.synth } : {}
    }
    trackOrder.push(id)
  }

  // A doctored file could still weave a folder cycle (A in B in A) —
  // break it deterministically by unparenting the first track whose
  // ancestor walk revisits itself, mirroring the reducer's convergence rule.
  for (const id of trackOrder) {
    const seen = new Set<string>()
    let current: string | null = id
    while (current !== null) {
      if (seen.has(current)) {
        tracks[id] = { ...tracks[id], parentId: null }
        break
      }
      seen.add(current)
      current = tracks[current]?.parentId ?? null
    }
  }

  const pluginIdMap = new Map<string, string>()
  const plugins: Record<string, PluginInstance> = {}
  for (const plugin of template.plugins) {
    const trackId = trackIdMap.get(plugin.trackId)
    if (!trackId) continue
    const id = newId('plg')
    pluginIdMap.set(plugin.id, id)
    plugins[id] = {
      id,
      trackId,
      descriptor: plugin.descriptor,
      enabled: plugin.enabled,
      rank: plugin.rank,
      params: plugin.params,
      stateBlob: plugin.stateBlob
    }
  }

  const routes: Record<string, Route> = {}
  for (const route of template.routes) {
    const trackId = trackIdMap.get(route.trackId)
    if (!trackId) continue
    const from = route.from === 'in' ? 'in' : pluginIdMap.get(route.from)
    const to = route.to === 'out' ? 'out' : pluginIdMap.get(route.to)
    if (!from || !to) continue
    const id = newId('rte')
    routes[id] = { id, trackId, from, to }
  }

  return {
    ...base,
    tempo: template.tempo,
    timeSignature: template.timeSignature,
    masterVolume: template.masterVolume,
    settings: template.settings,
    tracks,
    trackOrder,
    plugins,
    routes
  }
}
