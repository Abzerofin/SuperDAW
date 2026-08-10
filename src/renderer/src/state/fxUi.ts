import { useSyncExternalStore } from 'react'
import type { PluginInstanceId } from '@core/model/types'

/**
 * Which FX cards are collapsed to just their header — ephemeral per-user
 * UI state (like folder collapse), never part of the document.
 */
class FxUiStore {
  private collapsed = new Set<PluginInstanceId>()
  private version = 0
  private listeners = new Set<() => void>()

  isCollapsed(instanceId: PluginInstanceId): boolean {
    return this.collapsed.has(instanceId)
  }

  toggleCollapsed(instanceId: PluginInstanceId): void {
    if (!this.collapsed.delete(instanceId)) this.collapsed.add(instanceId)
    this.version++
    for (const listener of this.listeners) listener()
  }

  /** Start collapsed (new inserts): no visual or native GUI until opened. */
  collapse(instanceId: PluginInstanceId): void {
    if (this.collapsed.has(instanceId)) return
    this.collapsed.add(instanceId)
    this.version++
    for (const listener of this.listeners) listener()
  }

  getVersion = (): number => this.version

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
}

export const fxUi = new FxUiStore()

export function useFxUi(): FxUiStore {
  useSyncExternalStore(fxUi.subscribe, fxUi.getVersion)
  return fxUi
}
