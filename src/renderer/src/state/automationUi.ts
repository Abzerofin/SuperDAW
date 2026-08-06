import { useSyncExternalStore } from 'react'
import type { AutomationParam, TrackId } from '@core/model/types'

/**
 * Which tracks show their automation lane, and which parameter each lane
 * is editing (ephemeral, per-user).
 */
class AutomationUiStore {
  private open = new Set<TrackId>()
  private params = new Map<TrackId, AutomationParam>()
  private version = 0
  private listeners = new Set<() => void>()

  isOpen(trackId: TrackId): boolean {
    return this.open.has(trackId)
  }

  paramOf(trackId: TrackId): AutomationParam {
    return this.params.get(trackId) ?? 'volume'
  }

  setParam(trackId: TrackId, param: AutomationParam): void {
    this.params.set(trackId, param)
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
