import { useSyncExternalStore } from 'react'

/**
 * An optional one-click follow-up riding on a notice — the ask-flow that
 * fits the "notify once, never a popup" contract (e.g. "Stretch to fit"
 * after importing a loop whose tempo differs from the project's).
 */
export interface NoticeAction {
  readonly label: string
  readonly run: () => void
}

/**
 * One-shot app notices for the status bar — the same "notify once, never a
 * popup" contract the device-loss notice established, for events that are
 * not device events (an export's measured loudness, a completed bounce).
 * Showing a new notice replaces the old one; dismissing is a click.
 */
class StatusNoticeStore {
  notice: string | null = null
  action: NoticeAction | null = null

  private listeners = new Set<() => void>()

  show(text: string, action: NoticeAction | null = null): void {
    this.notice = text
    this.action = action
    this.emit()
  }

  dismiss(): void {
    if (this.notice === null) return
    this.notice = null
    this.action = null
    this.emit()
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getNotice = (): string | null => this.notice

  getAction = (): NoticeAction | null => this.action

  private emit(): void {
    for (const listener of this.listeners) listener()
  }
}

export const statusNotice = new StatusNoticeStore()

export function useStatusNotice(): string | null {
  return useSyncExternalStore(statusNotice.subscribe, statusNotice.getNotice)
}

export function useStatusNoticeAction(): NoticeAction | null {
  return useSyncExternalStore(statusNotice.subscribe, statusNotice.getAction)
}
