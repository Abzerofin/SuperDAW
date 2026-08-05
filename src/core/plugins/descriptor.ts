import type { ParamDef } from '../model/effects'

/**
 * Plugin identity — pure serializable metadata, part of the project
 * document. A descriptor NEVER contains filesystem paths: each client
 * resolves it against its own local plugin registry, so the same project
 * state can legitimately be LOCAL on one collaborator's machine and
 * MISSING on another's.
 */

export type PluginFormat = 'builtin' | 'vst2' | 'vst3' | 'clap' | 'au'

export interface PluginDescriptor {
  readonly format: PluginFormat
  /** Stable identifier within the format (builtin: 'superdaw.eq3'; VST3: class id; CLAP: plugin id). */
  readonly uid: string
  readonly name: string
  readonly vendor: string
  readonly version: string
  /**
   * Param metadata snapshot for non-builtin plugins, captured when the
   * plugin is first added. Lets the reducer clamp deterministically and
   * the UI render placeholder controls without the plugin installed.
   * Builtins omit this — their defs live in core and resolve by uid.
   */
  readonly paramDefs?: Readonly<Record<string, ParamDef>>
}

/** Stable identity string for maps/sets (identity = format + uid). */
export function descriptorKey(d: PluginDescriptor): string {
  return `${d.format}:${d.uid}`
}

/**
 * Resolution ladder, best first. 'format' matches (same plugin shipped in
 * a different format) must NEVER be used silently — they exist so the UI
 * can ask the user before substituting.
 */
export type MatchQuality = 'exact' | 'version' | 'format' | 'none'

/** How well `have` satisfies a project's request for `want`. */
export function matchDescriptor(want: PluginDescriptor, have: PluginDescriptor): MatchQuality {
  if (want.format === have.format && want.uid === have.uid) {
    return want.version === have.version ? 'exact' : 'version'
  }
  const norm = (s: string): string => s.trim().toLowerCase()
  if (norm(want.vendor) === norm(have.vendor) && norm(want.name) === norm(have.name)) {
    return 'format'
  }
  return 'none'
}

/**
 * What a plugin instance is doing on THIS client right now. Ephemeral,
 * computed per user — never stored in the document.
 *
 * local   — provider installed; fully editable.
 * remote  — missing here; audio streamed from a collaborator who has it.
 * proxy   — missing here; a rendered proxy plays; not editable.
 * missing — unavailable, no proxy; silent (bypassed) until resolved.
 */
export type PluginRuntimeStatus = 'local' | 'remote' | 'proxy' | 'missing'
