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
 * Structural check for descriptors read from FILES (project documents,
 * track presets) — anything off disk may be doctored or written by another
 * program, so a descriptor re-earns its shape before entering state. The
 * single source of truth for "is this a descriptor", shared by every
 * persistence layer.
 */
export function isPluginDescriptor(raw: unknown): raw is PluginDescriptor {
  const d = raw as Record<string, unknown> | null
  if (
    typeof d !== 'object' ||
    d === null ||
    typeof d.format !== 'string' ||
    typeof d.uid !== 'string' ||
    typeof d.name !== 'string' ||
    typeof d.vendor !== 'string' ||
    typeof d.version !== 'string'
  ) {
    return false
  }
  // paramDefs is optional, but present defs are load-bearing: the reducer
  // clamps every setParam with them, so a junk min/max would turn the
  // clamp into NaN in the synced document on every peer. Like any other
  // broken descriptor shape, malformed defs reject the descriptor whole
  // (its instance drops) rather than sanitizing per-def — partial repair
  // would let two peers disagree about which defs survived.
  if (d.paramDefs === undefined) return true
  if (typeof d.paramDefs !== 'object' || d.paramDefs === null || Array.isArray(d.paramDefs)) {
    return false
  }
  return Object.values(d.paramDefs).every(isParamDef)
}

function isParamDef(raw: unknown): boolean {
  if (typeof raw !== 'object' || raw === null) return false
  const def = raw as Record<string, unknown>
  const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
  return (
    typeof def.label === 'string' &&
    typeof def.unit === 'string' &&
    finite(def.min) &&
    finite(def.max) &&
    finite(def.default) &&
    finite(def.digits) &&
    def.min <= def.max
  )
}

/**
 * Where to send a user whose machine lacks this plugin.
 *
 * Built LOCALLY from the descriptor's identity, and always a fixed https
 * origin with the identity as an encoded query. A descriptor reaches this
 * client from a COLLABORATOR's machine, so a URL carried in the document
 * would be peer-controlled data flowing into `shell.openExternal` — i.e. an
 * injection vector (`file:`, custom protocol handlers, phishing). Reading a
 * URL out of the installed plugin instead doesn't help either: the machine
 * that needs the link is by definition the one with no plugin to read.
 */
export function pluginSearchUrl(d: PluginDescriptor): string {
  const terms = [d.vendor, d.name, d.format.toUpperCase(), 'plugin'].filter(
    (term) => term.trim().length > 0
  )
  return `https://duckduckgo.com/?q=${encodeURIComponent(terms.join(' '))}`
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
 * offline — installed here but hosted OUT OF PROCESS (VST3). Parameters
 *           are editable and its audio is rendered when the track is
 *           frozen, but it cannot run during live playback: the renderer
 *           is sandboxed and shared memory does not cross an Electron
 *           process boundary (see native/README.md).
 * remote  — missing here; audio streamed from a collaborator who has it.
 * proxy   — missing here; a rendered proxy plays; not editable.
 * missing — unavailable, no proxy; silent (bypassed) until resolved.
 */
export type PluginRuntimeStatus = 'local' | 'offline' | 'remote' | 'proxy' | 'missing'
