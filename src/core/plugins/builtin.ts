import type { EffectDef, EffectType, ParamDef } from '../model/effects'
import { EFFECT_DEFS, EFFECT_TYPES } from '../model/effects'
import type { PluginDescriptor } from './descriptor'

/**
 * Descriptors for the built-in plugin suite. Built-ins are first-class
 * plugins: they flow through the same descriptor → registry → provider
 * pipeline that external formats (VST/CLAP/AU) will use, which is how the
 * plugin architecture stays exercised long before any external host exists.
 */

export const BUILTIN_VENDOR = 'SuperDAW'
export const BUILTIN_VERSION = '1.0.0'

const uidOf = (type: EffectType): string => `superdaw.${type}`

/** uid → param defs for every builtin effect. */
const DEFS_BY_UID: Readonly<Record<string, EffectDef>> = Object.fromEntries(
  EFFECT_TYPES.map((type) => [uidOf(type), EFFECT_DEFS[type]])
)

export function builtinEffectDescriptor(type: EffectType): PluginDescriptor {
  return {
    format: 'builtin',
    uid: uidOf(type),
    name: EFFECT_DEFS[type].label,
    vendor: BUILTIN_VENDOR,
    version: BUILTIN_VERSION
  }
}

export const BUILTIN_EFFECT_DESCRIPTORS: readonly PluginDescriptor[] =
  EFFECT_TYPES.map(builtinEffectDescriptor)

/** Legacy EffectType for a builtin uid ('superdaw.eq3' → 'eq3'), or null. */
export function builtinTypeOf(descriptor: PluginDescriptor): EffectType | null {
  if (descriptor.format !== 'builtin') return null
  const type = descriptor.uid.replace(/^superdaw\./, '') as EffectType
  return EFFECT_DEFS[type] ? type : null
}

/**
 * Param defs for a descriptor: builtins resolve by uid against core defs
 * (single source of truth); external plugins use the snapshot captured in
 * the descriptor. null = unknown builtin or external without a snapshot.
 *
 * The reducer clamps with these. They derive ONLY from document data and
 * core code — never from local plugin availability — so every peer clamps
 * identically and stays convergent.
 */
export function paramDefsOf(
  descriptor: PluginDescriptor
): Readonly<Record<string, ParamDef>> | null {
  if (descriptor.format === 'builtin') return DEFS_BY_UID[descriptor.uid]?.params ?? null
  return descriptor.paramDefs ?? null
}

/**
 * Is this param a plugin-owned NORMALIZED 0..1 value rather than a real
 * unit? External formats report every parameter normalized — the plugin
 * owns the mapping to dB/Hz/ms and is the only thing that can format it —
 * so `externalParamDefs` keeps the units in the LABEL while the number
 * itself is a fraction. Rendering that raw gives "Threshold (dB)" above
 * "0.50", which reads as a wrong value rather than a normalized one. A
 * machine without the plugin cannot ask it to format, so a percentage is
 * the only honest presentation.
 *
 * Derived at display time rather than stored, so projects saved before
 * this existed read correctly too. Guarded on the exact shape
 * `externalParamDefs` produces, so a def carrying genuine units is left
 * alone.
 */
export function isNormalizedParam(descriptor: PluginDescriptor, def: ParamDef): boolean {
  return descriptor.format !== 'builtin' && def.min === 0 && def.max === 1 && def.unit === ''
}

export function pluginDefaults(descriptor: PluginDescriptor): Record<string, number> {
  const defs = paramDefsOf(descriptor)
  if (!defs) return {}
  return Object.fromEntries(Object.entries(defs).map(([k, def]) => [k, def.default]))
}
