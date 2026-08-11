import { useSyncExternalStore } from 'react'
import type { PluginInstanceId } from '@core/model/types'

/**
 * Docked VST3 editors: every offline insert shows its plugin's own GUI in
 * its card automatically. This store holds what the renderer needs to lay
 * that out — each editor's reported size, and which instances FAILED to
 * open an editor (no GUI, or a broken plugin) and fall back to generic
 * sliders. Ephemeral per-user UI state.
 *
 * The GUI itself is a borderless native overlay glued over a reserved
 * placeholder (a plugin cannot paint inside a Chromium window). The
 * placeholder component reports its viewport rect through
 * `window.superdaw.vst3DockEditor`; unmounting sends rect: null, which
 * captures the plugin's state exactly like closing a floating editor.
 */

export interface EditorDims {
  width: number
  height: number
}

class Vst3DockStore {
  private sizes = new Map<PluginInstanceId, EditorDims>()
  private failed = new Set<PluginInstanceId>()
  private version = 0
  private listeners = new Set<() => void>()

  dims(instanceId: PluginInstanceId): EditorDims | null {
    return this.sizes.get(instanceId) ?? null
  }

  setDims(instanceId: PluginInstanceId, dims: EditorDims): void {
    const current = this.sizes.get(instanceId)
    if (current && current.width === dims.width && current.height === dims.height) return
    this.sizes.set(instanceId, dims)
    this.emit()
  }

  /** This instance can't host a GUI here — its card shows sliders instead. */
  markFailed(instanceId: PluginInstanceId): void {
    if (this.failed.has(instanceId)) return
    this.failed.add(instanceId)
    this.emit()
  }

  /**
   * Forget a failure so the next mount retries the editor. Called on the
   * retry gestures (re-expanding the card) — one transient open failure
   * must not demote a plugin to generic sliders for the whole session. A
   * plugin with genuinely no GUI just fails again, cheaply.
   */
  clearFailed(instanceId: PluginInstanceId): void {
    if (!this.failed.delete(instanceId)) return
    this.emit()
  }

  isFailed(instanceId: PluginInstanceId): boolean {
    return this.failed.has(instanceId)
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
