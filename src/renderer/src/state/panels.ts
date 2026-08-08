import { useSyncExternalStore } from 'react'
import { projectStore } from './projectStore'

/**
 * Which panels are open — ephemeral per-user UI state. Also owns the
 * chat unread counter: messages from others arriving while the chat tab
 * is hidden accumulate; opening the tab clears them.
 */
export type RightPanel = 'activity' | 'chat' | null
export type BottomPanel = 'files' | 'mixer' | 'effects' | 'pianoroll' | null

class PanelStore {
  rightPanel: RightPanel = 'activity'
  bottomPanel: BottomPanel = 'files'
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

  toggleBottom(panel: Exclude<BottomPanel, null>): void {
    this.bottomPanel = this.bottomPanel === panel ? null : panel
    this.emit()
  }

  setBottom(panel: BottomPanel): void {
    if (this.bottomPanel === panel) return
    this.bottomPanel = panel
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
