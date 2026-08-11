import type { PluginInstance, Track, TrackKind } from '../model/types'
import { MAX_GAIN } from '../model/types'
import { newId } from '../model/ids'
import { SYNTH_DEFS, clampParam, synthDefaults } from '../model/effects'
import type { PluginDescriptor } from '../plugins/descriptor'
import { isPluginDescriptor } from '../plugins/descriptor'
import { paramDefsOf } from '../plugins/builtin'

/**
 * Track presets: portable JSON files carrying a track's sound — mixer
 * settings, synth params, color, optional name, and the full insert chain
 * as descriptor + params + stateBlob (never filesystem paths, exactly like
 * the document's plugin model, so presets travel between machines and can
 * be shared online later). Pure and validated like the project format;
 * loading emits a plain `track/create` op with fresh ids, so presets ride
 * the ordinary pipeline (undo, activity, sync) with zero new op types.
 */

export const TRACK_PRESET_VERSION = 1
export const TRACK_PRESET_EXTENSION = 'sdtp'

export interface TrackPresetJson {
  readonly kind: 'superdaw-track-preset'
  readonly formatVersion: number
  readonly name: string
  /** Present only when the user chose to include the track name. */
  readonly trackName?: string
  readonly track: {
    readonly kind: TrackKind
    readonly color: string
    readonly volume: number
    readonly pan: number
    readonly synth: Readonly<Record<string, number>>
  }
  readonly plugins: ReadonlyArray<{
    readonly descriptor: PluginDescriptor
    readonly enabled: boolean
    readonly rank: number
    readonly params: Readonly<Record<string, number>>
    readonly stateBlob: string | null
  }>
}

export function serializeTrackPreset(
  track: Track,
  plugins: readonly PluginInstance[],
  includeName: boolean
): string {
  const preset: TrackPresetJson = {
    kind: 'superdaw-track-preset',
    formatVersion: TRACK_PRESET_VERSION,
    name: track.name,
    ...(includeName ? { trackName: track.name } : {}),
    track: {
      kind: track.kind,
      color: track.color,
      volume: track.volume,
      pan: track.pan,
      synth: track.synth
    },
    plugins: plugins.map((p) => ({
      descriptor: p.descriptor,
      enabled: p.enabled,
      rank: p.rank,
      params: p.params,
      stateBlob: p.stateBlob
    }))
  }
  return JSON.stringify(preset, null, 2)
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

/** Parse and validate a preset file. Throws on anything unusable. */
export function parseTrackPreset(text: string): TrackPresetJson {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw new Error('Preset file is corrupted (invalid JSON)')
  }
  const p = raw as Record<string, unknown>
  if (typeof p !== 'object' || p === null || p.kind !== 'superdaw-track-preset') {
    throw new Error('Not a SuperDAW track preset')
  }
  if (typeof p.formatVersion !== 'number' || p.formatVersion > TRACK_PRESET_VERSION) {
    throw new Error('This preset was saved by a newer version of SuperDAW')
  }
  const track = p.track as Record<string, unknown> | undefined
  if (!track || !['audio', 'midi', 'folder'].includes(track.kind as string)) {
    throw new Error('Preset file is corrupted (bad track section)')
  }
  const kind = track.kind as TrackKind

  const synth: Record<string, number> = {}
  if (kind === 'midi') {
    const rawSynth = sanitizeNumbers(track.synth)
    for (const [key, def] of Object.entries(SYNTH_DEFS)) {
      synth[key] = clampParam(def, rawSynth[key] ?? def.default)
    }
  }

  const plugins: TrackPresetJson['plugins'] = (Array.isArray(p.plugins) ? p.plugins : [])
    .filter((entry: unknown) => isPluginDescriptor((entry as Record<string, unknown>)?.descriptor))
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
        descriptor,
        enabled: entry.enabled !== false,
        rank: typeof entry.rank === 'number' ? entry.rank : i + 1,
        params,
        stateBlob: typeof entry.stateBlob === 'string' ? entry.stateBlob : null
      }
    })
    // Builtin descriptors core doesn't know are unusable (reducer would drop them).
    .filter((entry) => entry.descriptor.format !== 'builtin' || paramDefsOf(entry.descriptor) !== null)

  return {
    kind: 'superdaw-track-preset',
    formatVersion: p.formatVersion,
    name: typeof p.name === 'string' && p.name.trim() ? p.name : 'Preset',
    ...(typeof p.trackName === 'string' && p.trackName.trim() ? { trackName: p.trackName } : {}),
    track: {
      kind,
      color: typeof track.color === 'string' ? track.color : '#5b8def',
      volume: clamp(typeof track.volume === 'number' ? track.volume : 1, 0, MAX_GAIN),
      pan: clamp(typeof track.pan === 'number' ? track.pan : 0, -1, 1),
      synth
    },
    plugins
  }
}

/** Materialize a preset as a new track + plugin instances with fresh ids. */
export function trackFromPreset(
  preset: TrackPresetJson,
  fallbackName: string
): { track: Track; plugins: PluginInstance[] } {
  const trackId = newId('trk')
  const track: Track = {
    id: trackId,
    kind: preset.track.kind,
    name: preset.trackName ?? fallbackName,
    color: preset.track.color,
    muted: false,
    soloed: false,
    parentId: null,
    frozenAssetId: null,
    volume: preset.track.volume,
    pan: preset.track.pan,
    synth: preset.track.kind === 'midi' ? { ...synthDefaults(), ...preset.track.synth } : {}
  }
  const plugins: PluginInstance[] = preset.plugins.map((p) => ({
    id: newId('plg'),
    trackId,
    descriptor: p.descriptor,
    enabled: p.enabled,
    rank: p.rank,
    params: p.params,
    stateBlob: p.stateBlob
  }))
  return { track, plugins }
}
