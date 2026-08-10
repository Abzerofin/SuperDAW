import { useSyncExternalStore } from 'react'
import type { PluginInstanceId, TrackId } from '@core/model/types'

/**
 * Which tracks show their automation lane, and what each lane is editing
 * (ephemeral, per-user). A target is the track's own volume/pan, or one
 * parameter of one insert effect when `instanceId` is set.
 */
export interface AutomationTarget {
  readonly param: string
  readonly instanceId?: PluginInstanceId
}

class AutomationUiStore {
  private open = new Set<TrackId>()
  private targets = new Map<TrackId, AutomationTarget>()
  private version = 0
  private listeners = new Set<() => void>()

  isOpen(trackId: TrackId): boolean {
    return this.open.has(trackId)
  }

  targetOf(trackId: TrackId): AutomationTarget {
    return this.targets.get(trackId) ?? { param: 'volume' }
  }

  setTarget(trackId: TrackId, target: AutomationTarget): void {
    this.targets.set(trackId, target)
    this.version++
    for (const listener of this.listeners) listener()
  }

  toggle(trackId: TrackId): void {
    if (!this.open.delete(trackId)) this.open.add(trackId)
    this.version++
    for (const listener of this.listeners) listener()
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getVersion = (): number => this.version
}

export const automationUi = new AutomationUiStore()

export function useAutomationUi(): AutomationUiStore {
  useSyncExternalStore(automationUi.subscribe, automationUi.getVersion)
  return automationUi
}
