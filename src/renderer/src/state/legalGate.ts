import { useSyncExternalStore } from 'react'

/**
 * Blocks the app behind a one-time-per-launch acknowledgement that plugin
 * licensing/EULA compliance is the user's responsibility (see
 * PLUGIN_LICENSE_TERMS.md). Deliberately NOT persisted — in-memory only, so
 * it re-asks every time the app starts, not just once ever.
 */
class LegalGateStore {
  accepted = false

  private version = 0
  private listeners = new Set<() => void>()

  accept(): void {
    this.accepted = true
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

export const legalGate = new LegalGateStore()

export function useLegalGate(): LegalGateStore {
  useSyncExternalStore(legalGate.subscribe, legalGate.getVersion)
  return legalGate
}
