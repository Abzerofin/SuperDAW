import { useSyncExternalStore } from 'react'
import { projectStore } from './projectStore'

/**
 * Dockable panel layout — ephemeral per-user UI state, persisted per
 * machine (never in the project). Every panel lives in exactly one dock
 * (bottom or right); each dock shows at most one panel at a time and can
 * be resized. Tabs can be dragged between docks so the workspace bends to
 * the user's workflow, not the other way round.
 *
 * Also owns the chat unread counter: messages from others arriving while
 * the chat panel is hidden accumulate; opening it clears them.
 */

export type PanelId =
  | 'files'
  | 'mixer'
  | 'effects'
  | 'pianoroll'
  | 'steps'
  | 'pads'
  | 'activity'
  | 'chat'
  | 'lyrics'
export type DockSide = 'bottom' | 'right'

export const PANEL_LABELS: Record<PanelId, string> = {
  files: 'Files',
  mixer: 'Mixer',
  effects: 'Effects',
  pianoroll: 'Piano',
  steps: 'Steps',
  pads: 'Pads',
  activity: 'Activity',
  chat: 'Chat',
  lyrics: 'Lyrics'
}

const ALL_PANELS: readonly PanelId[] = [
  'files',
  'mixer',
  'effects',
  'pianoroll',
  'steps',
  'pads',
  'activity',
  'chat',
  'lyrics'
]

interface DockLayout {
  docks: Record<DockSide, PanelId[]>
  active: Record<DockSide, PanelId | null>
  bottomHeight: number
  rightWidth: number
}

const DEFAULT_LAYOUT: DockLayout = {
  docks: {
    bottom: ['files', 'mixer', 'effects', 'pianoroll', 'steps', 'pads'],
    right: ['activity', 'chat', 'lyrics']
  },
  active: { bottom: 'files', right: 'activity' },
  bottomHeight: 240,
  rightWidth: 300
}

const STORAGE_KEY = 'superdaw.dockLayout'
const MIN_BOTTOM_H = 120
const MAX_BOTTOM_H = 600
const MIN_RIGHT_W = 220
const MAX_RIGHT_W = 640

function loadLayout(): DockLayout {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(STORAGE_KEY) : null
    if (!raw) return structuredClone(DEFAULT_LAYOUT)
    const parsed = JSON.parse(raw) as DockLayout
    // Panels from removed eras drop out; panels ADDED since the layout was
    // saved adopt their default dock — an app update must neither lose the
    // user's arrangement nor hide new tabs.
    for (const side of ['bottom', 'right'] as const) {
      parsed.docks[side] = parsed.docks[side].filter((id) => ALL_PANELS.includes(id))
    }
    const present = [...parsed.docks.bottom, ...parsed.docks.right]
    for (const id of ALL_PANELS) {
      if (present.includes(id)) continue
      parsed.docks[DEFAULT_LAYOUT.docks.right.includes(id) ? 'right' : 'bottom'].push(id)
    }
    const all = [...parsed.docks.bottom, ...parsed.docks.right]
    const valid =
      all.length === ALL_PANELS.length &&
      typeof parsed.bottomHeight === 'number' &&
      typeof parsed.rightWidth === 'number'
    if (!valid) return structuredClone(DEFAULT_LAYOUT)
    for (const side of ['bottom', 'right'] as const) {
      const active = parsed.active[side]
      if (active !== null && !parsed.docks[side].includes(active)) parsed.active[side] = null
    }
    return parsed
  } catch {
    return structuredClone(DEFAULT_LAYOUT)
  }
}

class PanelStore {
  layout: DockLayout = loadLayout()
  unreadChat = 0
  /** Document ops landed while the activity panel was hidden. */
  unreadActivity = 0

  private version = 0
  private listeners = new Set<() => void>()

  constructor() {
    projectStore.onOperation((envelope) => {
      if (envelope.op.type === 'chat/post') {
        if (envelope.op.message.userId !== projectStore.userId && !this.isOpen('chat')) {
          this.unreadChat++
          this.emit()
        }
        return // chat is deliberately absent from the activity feed
      }
      if (!this.isOpen('activity')) {
        this.unreadActivity++
        this.emit()
      }
    })
  }

  dockOf(id: PanelId): DockSide {
    return this.layout.docks.right.includes(id) ? 'right' : 'bottom'
  }

  isOpen(id: PanelId): boolean {
    return this.layout.active[this.dockOf(id)] === id
  }

  openPanel(id: PanelId): void {
    const side = this.dockOf(id)
    if (this.layout.active[side] === id) return
    this.layout.active[side] = id
    if (id === 'chat') this.unreadChat = 0
    if (id === 'activity') this.unreadActivity = 0
    this.persist()
    this.emit()
  }

  closePanel(id: PanelId): void {
    const side = this.dockOf(id)
    if (this.layout.active[side] !== id) return
    this.layout.active[side] = null
    this.persist()
    this.emit()
  }

  togglePanel(id: PanelId): void {
    this.isOpen(id) ? this.closePanel(id) : this.openPanel(id)
  }

  /** Re-home a tab (drag-and-drop). The moved panel becomes its dock's active one. */
  movePanel(id: PanelId, side: DockSide, index: number): void {
    const from = this.dockOf(id)
    if (this.layout.active[from] === id) this.layout.active[from] = null
    this.layout.docks[from] = this.layout.docks[from].filter((p) => p !== id)
    const target = this.layout.docks[side]
    target.splice(Math.min(Math.max(0, index), target.length), 0, id)
    this.layout.active[side] = id
    if (id === 'chat') this.unreadChat = 0
    if (id === 'activity') this.unreadActivity = 0
    this.persist()
    this.emit()
  }

  setBottomHeight(height: number): void {
    this.layout.bottomHeight = Math.min(MAX_BOTTOM_H, Math.max(MIN_BOTTOM_H, Math.round(height)))
    this.persist()
    this.emit()
  }

  setRightWidth(width: number): void {
    this.layout.rightWidth = Math.min(MAX_RIGHT_W, Math.max(MIN_RIGHT_W, Math.round(width)))
    this.persist()
    this.emit()
  }

  private persist(): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.layout))
    } catch {
      // Layout that doesn't persist must never break the session.
    }
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
