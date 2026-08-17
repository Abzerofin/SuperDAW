import type { PluginInstance } from '@core/model/types'
import type { ParamDef } from '@core/model/effects'
import type { PluginDescriptor } from '@core/plugins/descriptor'
import { descriptorKey } from '@core/plugins/descriptor'
import { pluginRegistry } from '@audio/pluginRegistry'
import type { ExternalPluginHost, ExternalRender } from '@audio/render'

/**
 * Index of VST3 plugins the MAIN process can run, and the bridge for
 * handing it audio. Availability is a per-client runtime fact like every
 * other plugin status — it is never stored in the document.
 *
 * Electron-only: in the browser build `window.superdaw` is absent, so
 * `scanExternalPlugins()` finds nothing and external inserts bypass,
 * exactly as a missing plugin does.
 */

export interface ExternalPluginEntry {
  uid: string
  name: string
  vendor: string
  version: string
  subCategories: string
}

/**
 * Scanned CLAP plugins (phase C1, docs/CLAP_AU_HOSTING.md): browsable and
 * addable, but NOT hostable yet — so they are deliberately kept OUT of the
 * registry's external index. An added CLAP insert shows the ordinary
 * missing-plugin placeholder and bypasses cleanly; claiming 'offline' for
 * it would make freeze advice and the export honesty notice lie.
 */
const clapByKey = new Map<string, ExternalPluginEntry>()

export interface PluginFailure {
  path: string
  reason: string
  crashed: boolean
}

/** descriptorKey -> entry, for the descriptors we can actually run. */
const byKey = new Map<string, ExternalPluginEntry>()
const listeners = new Set<() => void>()

let scanned = false
let scanError: string | null = null
let folders: string[] = []
let failures: PluginFailure[] = []
let scanning = false
let lastScanMs: number | null = null

/** Folders the scanner searches. Empty until the first status read. */
export function pluginFolders(): string[] {
  return folders
}

/** Bundles that would not load, and why. */
export function pluginFailures(): PluginFailure[] {
  return failures
}

export function pluginScanning(): boolean {
  return scanning
}

export function pluginLastScanMs(): number | null {
  return lastScanMs
}

/** Is an out-of-process plugin host reachable at all (i.e. the desktop app)? */
export function externalHostAvailable(): boolean {
  return typeof window.superdaw?.vst3Scan === 'function'
}

/** Why the last scan found nothing, or null if it was fine. */
export function externalScanError(): string | null {
  return scanError
}

/** Uids come off disk as-is; descriptors carry the same string. */
function keyOf(format: 'vst3' | 'clap', uid: string): string {
  return descriptorKey({ format, uid } as PluginDescriptor)
}

interface ScanStatus {
  plugins: (ExternalPluginEntry & { format?: 'vst3' | 'clap' })[]
  folders: string[]
  failures: PluginFailure[]
  scanning: boolean
  lastScanMs: number | null
}

/** One place where a scan result becomes app state, whatever produced it. */
function applyStatus(status: ScanStatus): void {
  byKey.clear()
  clapByKey.clear()
  for (const plugin of status.plugins) {
    // Older mains sent no format field; everything they scanned was VST3.
    const format = plugin.format === 'clap' ? 'clap' : 'vst3'
    const into = format === 'clap' ? clapByKey : byKey
    into.set(keyOf(format, plugin.uid), {
      uid: plugin.uid,
      name: plugin.name,
      vendor: plugin.vendor,
      version: plugin.version,
      subCategories: plugin.subCategories
    })
  }
  folders = status.folders
  failures = status.failures
  scanning = status.scanning
  lastScanMs = status.lastScanMs
  // Teach the registry which descriptors this client can render out of
  // process, so their status is 'offline' rather than 'missing'. VST3
  // ONLY: scanned CLAPs cannot be processed yet (see clapByKey).
  pluginRegistry.setExternalIndex((descriptor) => byKey.has(descriptorKey(descriptor)))
  emit()
}

function emit(): void {
  for (const listener of listeners) listener()
}

/**
 * Run a main-process plugin operation and fold the result into app state.
 * A failed scan must SAY so — silently rendering nothing is
 * indistinguishable from "you own no plugins".
 */
async function withStatus(
  run: () => Promise<ScanStatus>,
  { busy }: { busy: boolean } = { busy: false }
): Promise<void> {
  if (busy) {
    scanning = true
    emit()
  }
  try {
    applyStatus(await run())
    scanError = null
  } catch (error) {
    scanError = error instanceof Error ? error.message : String(error)
    scanning = false
    emit()
  }
}

export async function scanExternalPlugins(): Promise<void> {
  // Module-scope callers run under vitest too, where there is no window.
  if (typeof window === 'undefined') return
  const api = window.superdaw
  if (!api?.pluginStatus) return
  scanned = true
  await withStatus(() => api.pluginStatus!())
}

/**
 * "Refresh Plugins": force main to re-inspect every bundle and retry the
 * ones that previously crashed. Slower than a normal scan by design — it
 * is the button you press when the cache might be wrong.
 */
export async function refreshExternalPlugins(): Promise<void> {
  const api = window.superdaw
  if (!api?.pluginRefresh) return
  scanned = true
  await withStatus(() => api.pluginRefresh!(), { busy: true })
}

export async function setPluginFolders(next: string[]): Promise<void> {
  const api = window.superdaw
  if (!api?.pluginSetFolders) return
  await withStatus(() => api.pluginSetFolders!(next), { busy: true })
}

/** Open the OS folder picker and add the choice to the search list. */
export async function addPluginFolder(): Promise<void> {
  const api = window.superdaw
  if (!api?.pluginBrowseFolder || !api.pluginSetFolders) return
  const picked = await api.pluginBrowseFolder()
  if (!picked) return
  await setPluginFolders([...folders, picked])
}

export async function resetPluginFolders(): Promise<void> {
  const api = window.superdaw
  if (!api?.pluginResetFolders) return
  await withStatus(() => api.pluginResetFolders!(), { busy: true })
}

export async function clearPluginQuarantine(): Promise<void> {
  const api = window.superdaw
  if (!api?.pluginClearQuarantine) return
  await withStatus(() => api.pluginClearQuarantine!(), { busy: true })
}

/**
 * Keep this module in step with scans main runs on its own (the startup
 * one, or a refresh triggered from another window). Wired once at import.
 */
if (typeof window !== 'undefined') {
  window.superdaw?.onPluginsChanged?.(() => {
    const api = window.superdaw
    if (api?.pluginStatus) void withStatus(() => api.pluginStatus!())
  })
}

/**
 * Snapshot a plugin's parameters into the shape the document stores.
 *
 * VST3 values are NORMALIZED 0..1 and the plugin owns the mapping to real
 * units, so these defs are 0..1 with no unit suffix — labelling a 0.50 as
 * "dB" would be a lie. The parameter's real-world units go in the label so
 * the control is still identifiable.
 *
 * Captured at add-time and stored in the descriptor, per the plugin
 * architecture: the reducer then clamps identically on every peer,
 * including peers that do not have the plugin at all.
 */
export async function externalParamDefs(
  uid: string
): Promise<Record<string, ParamDef> | null> {
  const api = window.superdaw
  if (!api?.vst3Parameters) return null
  const result = await api.vst3Parameters(uid)
  if (result.error || !result.parameters) return null
  const defs: Record<string, ParamDef> = {}
  for (const param of result.parameters) {
    if (param.isBypass) continue // the chain already has its own bypass
    const units = param.units.trim()
    defs[String(param.id)] = {
      label: units ? `${param.title} (${units})` : param.title,
      min: 0,
      max: 1,
      default: param.defaultNormalized,
      unit: '',
      digits: 2
    }
  }
  return defs
}

export function externalPlugins(): ExternalPluginEntry[] {
  return [...byKey.values()].sort((a, b) => a.name.localeCompare(b.name))
}

/** Scanned CLAP plugins — browsable/addable placeholders until C2+ lands. */
export function clapPlugins(): ExternalPluginEntry[] {
  return [...clapByKey.values()].sort((a, b) => a.name.localeCompare(b.name))
}

export function hasScanned(): boolean {
  return scanned
}

export function subscribeExternalPlugins(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/**
 * The host handed to `renderTrackFreeze`. Null when nothing external is
 * available, so the freeze path keeps its single-pass fast route.
 */
export function externalPluginHost(): ExternalPluginHost | null {
  const api = window.superdaw
  if (!api?.vst3Process || byKey.size === 0) return null
  return {
    has: (descriptor) => byKey.has(descriptorKey(descriptor)),
    process: async (
      instance: PluginInstance,
      channels: Float32Array[],
      sampleRate: number
    ): Promise<ExternalRender | null> => {
      const result = await api.vst3Process({
        uid: instance.descriptor.uid,
        channels,
        sampleRate,
        // Param keys are the plugin's own numeric ids, stringified.
        params: instance.params,
        stateBlob: instance.stateBlob
      })
      // Failure bypasses rather than aborting the freeze — same rule the
      // reducer follows for ops whose target is gone.
      if (result.error || !result.channels) {
        console.warn(
          `VST3 "${instance.descriptor.name}" offline process failed: ${result.error ?? 'no audio returned'}`
        )
        return null
      }
      // The caller trims this off the head, so a frozen track lands on the
      // grid instead of behind it by the plugin's own delay.
      return { channels: result.channels, latencySamples: result.latencySamples }
    },

    open: async (instance, sampleRate, channels) => {
      if (!api.vst3OpenInstance || !api.vst3ProcessInstance || !api.vst3CloseInstance) {
        return null
      }
      const opened = await api.vst3OpenInstance({
        uid: instance.descriptor.uid,
        sampleRate,
        channels,
        stateBlob: instance.stateBlob
      })
      if (opened.error || opened.handle === undefined) {
        console.warn(
          `VST3 "${instance.descriptor.name}" failed to open: ${opened.error ?? 'no handle returned'}`
        )
        return null
      }
      const handle = opened.handle
      let closed = false
      return {
        latencySamples: opened.latencySamples ?? 0,
        process: async (chunk, params) => {
          if (closed) return null
          const result = await api.vst3ProcessInstance!({
            handle,
            channels: chunk,
            params: params as Record<string, number>
          })
          if (result.error || !result.channels) {
            console.warn(
              `VST3 "${instance.descriptor.name}" process failed: ${result.error ?? 'no audio returned'}`
            )
            return null
          }
          return result.channels
        },
        close: () => {
          if (closed) return
          closed = true
          // Fire and forget: a leaked handle would hold the plugin loaded
          // for the life of the main process.
          void api.vst3CloseInstance!(handle)
        }
      }
    }
  }
}
