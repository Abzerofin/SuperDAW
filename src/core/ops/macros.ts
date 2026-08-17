import type { PluginInstanceId, ProjectState, TrackId } from '../model/types'
import { MAX_MACROS } from '../model/macros'
import { clampParam } from '../model/effects'
import { paramDefsOf } from '../plugins/builtin'
import type { Operation } from './operations'

export type MacroSetValueOp = Extract<Operation, { type: 'macro/setValue' }>

export interface MacroParamValue {
  readonly instanceId: PluginInstanceId
  readonly param: string
  readonly value: number
}

/**
 * The ABSOLUTE param values a macro position produces: for each LIVE
 * target (instance exists on that track; param known to its defs when
 * defs are known), value' = min + (max − min) · macroValue — min > max
 * legally inverts the sweep — clamped through the descriptor's paramDefs
 * exactly as plugin/setParam clamps. Dead targets (the pad rule: their
 * instance was deleted) are skipped. Pure and derived only from document
 * data, so every peer computes identically; the UI also uses this for
 * live drag previews.
 */
export function macroParamValues(
  state: ProjectState,
  trackId: TrackId,
  index: number,
  value: number
): MacroParamValue[] {
  const macro = state.tracks[trackId]?.macros?.[index]
  if (!macro || !Number.isFinite(value)) return []
  const position = Math.min(1, Math.max(0, value))
  const out: MacroParamValue[] = []
  for (const target of macro.targets) {
    const instance = state.plugins[target.instanceId]
    if (!instance || instance.trackId !== trackId) continue // dead target — skip
    const defs = paramDefsOf(instance.descriptor)
    const def = defs?.[target.param]
    if (defs && !def) continue
    const raw = target.min + (target.max - target.min) * position
    out.push({
      instanceId: target.instanceId,
      param: target.param,
      value: def ? clampParam(def, raw) : raw
    })
  }
  return out
}

/**
 * Build the ONE op a macro-knob gesture dispatches on release: the new
 * knob position plus the derived absolute param values riding along (see
 * the `macro/setValue` doc in operations.ts for why they are carried).
 * Null when the track or slot index is unusable. A macro with no live
 * targets still yields an op — the knob position itself is document state.
 */
export function buildMacroSetValue(
  state: ProjectState,
  trackId: TrackId,
  index: number,
  value: number
): MacroSetValueOp | null {
  if (!state.tracks[trackId]) return null
  if (!Number.isInteger(index) || index < 0 || index >= MAX_MACROS) return null
  if (!Number.isFinite(value)) return null
  const position = Math.min(1, Math.max(0, value))
  return {
    type: 'macro/setValue',
    trackId,
    index,
    value: position,
    params: macroParamValues(state, trackId, index, position)
  }
}
