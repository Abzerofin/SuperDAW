import type { PluginInstance, ProjectState, TrackId } from '../model/types'
import type { PluginDescriptor } from './descriptor'
import { descriptorKey } from './descriptor'

/**
 * The plugin manifest is DERIVED from project state, never stored — a
 * stored copy could only drift from the truth. It answers "which plugins
 * does this project need, and where are they used?"; each client joins it
 * with its own registry to show compatibility.
 */

export interface PluginManifestEntry {
  readonly descriptor: PluginDescriptor
  readonly instances: readonly PluginInstance[]
  /** Tracks using the plugin, in project track order. */
  readonly trackIds: readonly TrackId[]
}

/** Every distinct plugin in use, ordered by first appearance in track order. */
export function pluginManifest(state: ProjectState): PluginManifestEntry[] {
  const byKey = new Map<string, { descriptor: PluginDescriptor; instances: PluginInstance[] }>()
  for (const instance of Object.values(state.plugins)) {
    const key = descriptorKey(instance.descriptor)
    const entry = byKey.get(key)
    if (entry) entry.instances.push(instance)
    else byKey.set(key, { descriptor: instance.descriptor, instances: [instance] })
  }
  const trackRank = new Map(state.trackOrder.map((id, i) => [id, i]))
  const rankOf = (t: TrackId): number => trackRank.get(t) ?? Number.MAX_SAFE_INTEGER
  const entries: PluginManifestEntry[] = []
  for (const { descriptor, instances } of byKey.values()) {
    const trackIds = [...new Set(instances.map((i) => i.trackId))].sort(
      (a, b) => rankOf(a) - rankOf(b)
    )
    entries.push({ descriptor, instances, trackIds })
  }
  return entries.sort(
    (a, b) => rankOf(a.trackIds[0]) - rankOf(b.trackIds[0]) || a.descriptor.name.localeCompare(b.descriptor.name)
  )
}
