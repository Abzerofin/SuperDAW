import { useSyncExternalStore } from 'react'
import type { HistoryKind } from './itemHistory'

/**
 * Which item's history popover is open (ephemeral, per-user). One popover
 * at a time, opened from the clip menu, track menu or an FX card, closed
 * by ×, Escape or clicking anywhere else.
 */
export interface HistoryPopoverTarget {
  readonly kind: HistoryKind
  readonly id: string
  readonly title: string
  /** Viewport coords the popover anchors near (clamped on screen). */
  readonly x: number
  readonly y: number
}

class HistoryUiStore {
  current: HistoryPopoverTarget | null = null
  private version = 0
  private listeners = new Set<() => void>()

  open(target: HistoryPopoverTarget): void {
    this.current = target
    this.emit()
  }

  close(): void {
    if (!this.current) return
    this.current = null
    this.emit()
  }

  getVersion = (): number => this.version

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private emit(): void {
    this.version++
    for (const listener of this.listeners) listener()
  }
}

export const historyUi = new HistoryUiStore()

export function useHistoryUi(): HistoryUiStore {
  useSyncExternalStore(historyUi.subscribe, historyUi.getVersion)
  return historyUi
}
