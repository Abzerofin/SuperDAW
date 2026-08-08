import { useSyncExternalStore } from 'react'
import type { PluginInstanceId } from '@core/model/types'
import { wireEditorEvents } from './vst3Editors'

/**
 * Which VST3 inserts have their GUI expanded INSIDE the Effects dock, and
 * how big each plugin says its editor is. Ephemeral per-user UI state.
 *
 * The GUI itself is a borderless native overlay glued over a reserved
 * placeholder (a plugin cannot paint inside a Chromium window). The
 * placeholder component reports its viewport rect through
 * `window.superdaw.vst3DockEditor`; collapsing sends rect: null, which
 * captures the plugin's state exactly like closing a floating editor.
 */

export interface EditorDims {
  width: number
  height: number
}

class Vst3DockStore {
  private expanded = new Map<PluginInstanceId, EditorDims>()
  private version = 0
  private listeners = new Set<() => void>()

  isExpanded(instanceId: PluginInstanceId): boolean {
    return this.expanded.has(instanceId)
  }

  dims(instanceId: PluginInstanceId): EditorDims | null {
    return this.expanded.get(instanceId) ?? null
  }

  toggle(instanceId: PluginInstanceId): void {
    if (this.expanded.has(instanceId)) {
      this.expanded.delete(instanceId)
    } else {
      // Real dimensions arrive from the plugin once its editor opens.
      this.expanded.set(instanceId, { width: 480, height: 320 })
      wireEditorEvents()
    }
    this.emit()
  }

  collapse(instanceId: PluginInstanceId): void {
    if (this.expanded.delete(instanceId)) this.emit()
  }

  setDims(instanceId: PluginInstanceId, dims: EditorDims): void {
    const current = this.expanded.get(instanceId)
    if (!current || (current.width === dims.width && current.height === dims.height)) return
    this.expanded.set(instanceId, dims)
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

export const vst3Dock = new Vst3DockStore()

export function useVst3Dock(): Vst3DockStore {
  useSyncExternalStore(vst3Dock.subscribe, vst3Dock.getVersion)
  return vst3Dock
}
