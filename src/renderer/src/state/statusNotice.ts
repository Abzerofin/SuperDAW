import { useSyncExternalStore } from 'react'

/**
 * One-shot app notices for the status bar — the same "notify once, never a
 * popup" contract the device-loss notice established, for events that are
 * not device events (an export's measured loudness, a completed bounce).
 * Showing a new notice replaces the old one; dismissing is a click.
 */
class StatusNoticeStore {
  notice: string | null = null

  private listeners = new Set<() => void>()

  show(text: string): void {
    this.notice = text
    this.emit()
  }

  dismiss(): void {
    if (this.notice === null) return
    this.notice = null
    this.emit()
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getNotice = (): string | null => this.notice

  private emit(): void {
    for (const listener of this.listeners) listener()
  }
}

export const statusNotice = new StatusNoticeStore()

export function useStatusNotice(): string | null {
  return useSyncExternalStore(statusNotice.subscribe, statusNotice.getNotice)
}
