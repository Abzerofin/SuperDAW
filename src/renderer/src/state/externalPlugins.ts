import type { PluginInstance } from '@core/model/types'
import type { PluginDescriptor } from '@core/plugins/descriptor'
import { descriptorKey } from '@core/plugins/descriptor'
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

/** VST3 uids come off disk as-is; descriptors carry the same string. */
function keyOf(uid: string): string {
  return descriptorKey({ format: 'vst3', uid } as PluginDescriptor)
}

export async function scanExternalPlugins(): Promise<void> {
  const api = window.superdaw
  if (!api?.vst3Scan) return
  const found = await api.vst3Scan()
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
  scanned = true
  for (const listener of listeners) listener()
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
        sampleRate
      })
      // Failure bypasses rather than aborting the freeze — same rule the
      // reducer follows for ops whose target is gone.
      if (result.error || !result.channels) return null
      return result.channels
    }
  }
}
