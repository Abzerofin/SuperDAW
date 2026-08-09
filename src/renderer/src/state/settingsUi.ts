import { useSyncExternalStore } from 'react'

/**
 * Settings window visibility — ephemeral UI state. Sections are a fixed
 * roster so future panes (shortcuts, …) slot in without touching the
 * window shell.
 */
export type SettingsSection =
  | 'general'
  | 'audio'
  | 'themes'
  | 'shortcuts'
  | 'collaboration'
  | 'plugins'

/** Sections that have a real pane today; the rest render as "coming soon". */
export const IMPLEMENTED_SECTIONS: ReadonlySet<SettingsSection> = new Set([
  'general',
  'audio',
  'themes',
  'collaboration',
  'plugins'
])

class SettingsUiStore {
  isOpen = false
  section: SettingsSection = 'general'

  private version = 0
  private listeners = new Set<() => void>()

  open(section?: SettingsSection): void {
    this.isOpen = true
    if (section) this.section = section
    this.emit()
  }

  close(): void {
    if (!this.isOpen) return
    this.isOpen = false
    this.emit()
  }

  setSection(section: SettingsSection): void {
    this.section = section
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

export const settingsUi = new SettingsUiStore()

export function useSettingsUi(): SettingsUiStore {
  useSyncExternalStore(settingsUi.subscribe, settingsUi.getVersion)
  return settingsUi
}
