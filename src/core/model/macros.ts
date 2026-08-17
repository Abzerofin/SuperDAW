import type { PluginInstance, PluginInstanceId, TrackId } from './types'
import { paramDefsOf } from '../plugins/builtin'

/**
 * Per-track MACRO CONTROLS: up to four named knobs on a track, each mapped
 * to one or more insert-effect parameters, so one knob sweeps a whole
 * sound. The macro's value is normalized 0..1 and maps LINEARLY onto each
 * target's [min, max] range (the param's real units; min > max is legal
 * and means the mapping is inverted).
 *
 * Macros are document state on the Track (`Track.macros`, additive —
 * absent = none, so older files need no migration). Targets follow the
 * PAD RULE: a target whose plugin instance is later deleted stays in the
 * document and simply stops applying (`plugin/remove` deliberately does
 * NOT cascade macros; dead targets are skipped at build/apply time and
 * dropped on file load). Undo of the remove brings the mapping back to
 * life untouched.
 */

export const MAX_MACROS = 4

export interface MacroTarget {
  readonly instanceId: PluginInstanceId
  /** A param name of the instance's descriptor defs. */
  readonly param: string
  /** Mapped range in the PARAM's real units; min > max inverts the sweep. */
  readonly min: number
  readonly max: number
}

export interface TrackMacro {
  readonly name: string
  /** Normalized knob position 0..1. */
  readonly value: number
  readonly targets: readonly MacroTarget[]
}

export function macroDefaultName(index: number): string {
  return `Macro ${index + 1}`
}

export function defaultMacro(index: number): TrackMacro {
  return { name: macroDefaultName(index), value: 0, targets: [] }
}

function isDefaultMacro(macro: TrackMacro, index: number): boolean {
  return macro.name === macroDefaultName(index) && macro.value === 0 && macro.targets.length === 0
}

/**
 * Canonical form of a track's macro array: trailing all-default slots are
 * trimmed and an empty array collapses to ABSENT (undefined), so a track
 * whose macros were configured and then fully reset round-trips to a track
 * identical to one that never had any — which is what makes the macro ops'
 * inverts exact (the same convention as Clip.warp).
 */
export function canonicalMacros(
  macros: readonly TrackMacro[]
): readonly TrackMacro[] | undefined {
  let end = Math.min(macros.length, MAX_MACROS)
  while (end > 0 && isDefaultMacro(macros[end - 1], end - 1)) end--
  return end === 0 ? undefined : macros.slice(0, end)
}

/**
 * The working array for a macro edit: existing slots kept, absent slots up
 * to `index` filled with defaults (never longer than MAX_MACROS).
 */
export function materializeMacros(
  macros: readonly TrackMacro[] | undefined,
  index: number
): TrackMacro[] {
  const length = Math.min(MAX_MACROS, Math.max(index + 1, macros?.length ?? 0))
  const out: TrackMacro[] = []
  for (let i = 0; i < length; i++) out.push(macros?.[i] ?? defaultMacro(i))
  return out
}

export function macroTargetsEqual(
  a: readonly MacroTarget[],
  b: readonly MacroTarget[]
): boolean {
  if (a.length !== b.length) return false
  return a.every(
    (t, i) =>
      t.instanceId === b[i].instanceId &&
      t.param === b[i].param &&
      t.min === b[i].min &&
      t.max === b[i].max
  )
}

export function macrosEqual(
  a: readonly TrackMacro[] | undefined,
  b: readonly TrackMacro[] | undefined
): boolean {
  if (a === b) return true
  if (a === undefined || b === undefined) return false
  if (a.length !== b.length) return false
  return a.every(
    (m, i) =>
      m.name === b[i].name && m.value === b[i].value && macroTargetsEqual(m.targets, b[i].targets)
  )
}

/**
 * Field-by-field target hygiene, shared by the reducer (`macro/configure`)
 * and the file loader: the instance must exist ON THAT TRACK, the param
 * must be one of its known defs (when defs are known — external plugins
 * without a snapshot pass any name, exactly like plugin/setParam), and the
 * range must be finite. Null = unusable, dropped individually. Derives
 * only from document data so every peer validates identically.
 */
export function sanitizeMacroTarget(
  raw: unknown,
  trackId: TrackId,
  plugins: Readonly<Record<PluginInstanceId, PluginInstance>>
): MacroTarget | null {
  if (typeof raw !== 'object' || raw === null) return null
  const t = raw as Record<string, unknown>
  if (typeof t.instanceId !== 'string' || typeof t.param !== 'string' || t.param === '') return null
  const instance = plugins[t.instanceId]
  if (!instance || instance.trackId !== trackId) return null
  const defs = paramDefsOf(instance.descriptor)
  if (defs && !defs[t.param]) return null
  if (typeof t.min !== 'number' || !Number.isFinite(t.min)) return null
  if (typeof t.max !== 'number' || !Number.isFinite(t.max)) return null
  return { instanceId: t.instanceId, param: t.param, min: t.min, max: t.max }
}

/**
 * Load-time hygiene for a track's whole `macros` field (persistence):
 * junk → absent; each entry sanitized field by field (junk entries become
 * defaults); targets re-earn their place through `sanitizeMacroTarget`
 * with duplicates dropped, exactly as the reducer validates them; the
 * result is canonicalized. A loaded document is then indistinguishable
 * from one built by ops. Note this DROPS stale dead targets a live
 * document would carry (the pad rule keeps them in memory only until the
 * next save) — they no longer apply either way.
 */
export function sanitizeTrackMacros(
  raw: unknown,
  trackId: TrackId,
  plugins: Readonly<Record<PluginInstanceId, PluginInstance>>
): readonly TrackMacro[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const out: TrackMacro[] = []
  for (let i = 0; i < Math.min(raw.length, MAX_MACROS); i++) {
    const entry = raw[i] as Record<string, unknown> | null
    if (typeof entry !== 'object' || entry === null) {
      out.push(defaultMacro(i))
      continue
    }
    const targets: MacroTarget[] = []
    for (const rawTarget of Array.isArray(entry.targets) ? entry.targets : []) {
      const target = sanitizeMacroTarget(rawTarget, trackId, plugins)
      if (!target) continue
      if (targets.some((t) => t.instanceId === target.instanceId && t.param === target.param)) {
        continue
      }
      targets.push(target)
    }
    out.push({
      name:
        typeof entry.name === 'string' && entry.name !== '' ? entry.name : macroDefaultName(i),
      value:
        typeof entry.value === 'number' && Number.isFinite(entry.value)
          ? Math.min(1, Math.max(0, entry.value))
          : 0,
      targets
    })
  }
  return canonicalMacros(out)
}
