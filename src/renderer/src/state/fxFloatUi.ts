import { useSyncExternalStore } from 'react'
import type { PluginInstanceId } from '@core/model/types'

/**
 * Undocked effect windows — which plugin instances float over the app and
 * where. Ephemeral per-user UI state: never in the project document, and
 * deliberately not persisted (instance ids are per-project and a fresh
 * session starts with everything racked).
 */
class FxFloatStore {
  private windows = new Map<PluginInstanceId, { x: number; y: number }>()
  private version = 0
  private listeners = new Set<() => void>()

  isFloating(id: PluginInstanceId): boolean {
    return this.windows.has(id)
  }

  positionOf(id: PluginInstanceId): { x: number; y: number } | undefined {
    return this.windows.get(id)
  }

  ids(): PluginInstanceId[] {
    return [...this.windows.keys()]
  }

  float(id: PluginInstanceId, x: number, y: number): void {
    this.windows.set(id, { x, y })
    this.emit()
  }

  move(id: PluginInstanceId, x: number, y: number): void {
    if (!this.windows.has(id)) return
    this.windows.set(id, { x, y })
    this.emit()
  }

  /** Close the window; the device shows in the rack again. */
  dock(id: PluginInstanceId): void {
    if (!this.windows.delete(id)) return
    this.emit()
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getVersion = (): number => this.version

  private emit(): void {
    this.version++
    for (const listener of this.listeners) listener()
  }
}

export const fxFloatUi = new FxFloatStore()

export function useFxFloatUi(): FxFloatStore {
  useSyncExternalStore(fxFloatUi.subscribe, fxFloatUi.getVersion)
  return fxFloatUi
}
