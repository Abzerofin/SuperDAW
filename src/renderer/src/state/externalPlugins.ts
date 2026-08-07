import type { PluginInstance } from '@core/model/types'
import type { ParamDef } from '@core/model/effects'
import type { PluginDescriptor } from '@core/plugins/descriptor'
import { descriptorKey } from '@core/plugins/descriptor'
import { pluginRegistry } from '@audio/pluginRegistry'
import type { ExternalPluginHost } from '@audio/render'

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

/** descriptorKey -> entry, for the descriptors we can actually run. */
const byKey = new Map<string, ExternalPluginEntry>()
const listeners = new Set<() => void>()

let scanned = false
let scanError: string | null = null

/** Is an out-of-process plugin host reachable at all (i.e. the desktop app)? */
export function externalHostAvailable(): boolean {
  return typeof window.superdaw?.vst3Scan === 'function'
}

/** Why the last scan found nothing, or null if it was fine. */
export function externalScanError(): string | null {
  return scanError
}

/** VST3 uids come off disk as-is; descriptors carry the same string. */
function keyOf(uid: string): string {
  return descriptorKey({ format: 'vst3', uid } as PluginDescriptor)
}

export async function scanExternalPlugins(): Promise<void> {
  const api = window.superdaw
  if (!api?.vst3Scan) return
  scanned = true
  scanError = null
  let found: Awaited<ReturnType<NonNullable<typeof api.vst3Scan>>>
  try {
    found = await api.vst3Scan()
  } catch (error) {
    // A failed scan must SAY so. Silently rendering nothing is
    // indistinguishable from "you own no plugins".
    scanError = error instanceof Error ? error.message : String(error)
    for (const listener of listeners) listener()
    return
  }
  byKey.clear()
  for (const plugin of found) {
    byKey.set(keyOf(plugin.uid), {
      uid: plugin.uid,
      name: plugin.name,
      vendor: plugin.vendor,
      version: plugin.version,
      subCategories: plugin.subCategories
    })
  }
  // Teach the registry which descriptors this client can render out of
  // process, so their status is 'offline' rather than 'missing'.
  pluginRegistry.setExternalIndex((descriptor) => byKey.has(descriptorKey(descriptor)))
  for (const listener of listeners) listener()
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
    ): Promise<Float32Array[] | null> => {
      const result = await api.vst3Process({
        uid: instance.descriptor.uid,
        channels,
        sampleRate,
        // Param keys are the plugin's own numeric ids, stringified.
        params: instance.params
      })
      // Failure bypasses rather than aborting the freeze — same rule the
      // reducer follows for ops whose target is gone.
      if (result.error || !result.channels) return null
      return result.channels
    }
  }
}
