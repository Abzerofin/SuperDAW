import { useSyncExternalStore } from 'react'
import { projectStore } from './projectStore'

/**
 * Which panels are open — ephemeral per-user UI state. Also owns the
 * chat unread counter: messages from others arriving while the chat tab
 * is hidden accumulate; opening the tab clears them.
 */
export type RightPanel = 'activity' | 'chat' | null

class PanelStore {
  rightPanel: RightPanel = 'activity'
  bayOpen = true
  unreadChat = 0

  private version = 0
  private listeners = new Set<() => void>()

  constructor() {
    projectStore.onOperation((envelope) => {
      if (
        envelope.op.type === 'chat/post' &&
        envelope.op.message.userId !== projectStore.userId &&
        this.rightPanel !== 'chat'
      ) {
        this.unreadChat++
        this.emit()
      }
    })
  }

  toggleRight(panel: Exclude<RightPanel, null>): void {
    this.rightPanel = this.rightPanel === panel ? null : panel
    if (this.rightPanel === 'chat') this.unreadChat = 0
    this.emit()
  }

  toggleBay(): void {
    this.bayOpen = !this.bayOpen
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

export const panels = new PanelStore()

export function usePanels(): PanelStore {
  useSyncExternalStore(panels.subscribe, panels.getVersion)
  return panels
}
