import { useSyncExternalStore } from 'react'
import { appStorageGet, appStorageSet } from './appStorage'

/**
 * Small app-level preferences (Settings ▸ General / Collaboration).
 * App state, never document state — personal, persisted through the
 * appStorage seam, synced to no one.
 */

/** What a project-tempo change does to existing audio clips. */
export type TempoConformChoice = 'ask' | 'always' | 'never'

interface Preferences {
  /** Middle-CLICK sends a collaboration ping (drag always pans). */
  middleClickPing: boolean
  /** Fetch collaborators' assets automatically; off = ask first. */
  autoDownloadAssets: boolean
  /** Stretch audio clips to follow BPM changes: ask / always / never. */
  tempoConform: TempoConformChoice
}

const DEFAULTS: Preferences = {
  middleClickPing: true,
  autoDownloadAssets: false,
  tempoConform: 'ask'
}

const STORAGE_KEY = 'preferences'

class PreferencesStore {
  private prefs: Preferences = { ...DEFAULTS }
  private version = 0
  private listeners = new Set<() => void>()

  constructor() {
    void this.init()
  }

  private async init(): Promise<void> {
    const stored = await appStorageGet<Partial<Preferences>>(STORAGE_KEY)
    if (!stored) return
    this.prefs = {
      middleClickPing:
        typeof stored.middleClickPing === 'boolean'
          ? stored.middleClickPing
          : DEFAULTS.middleClickPing,
      autoDownloadAssets:
        typeof stored.autoDownloadAssets === 'boolean'
          ? stored.autoDownloadAssets
          : DEFAULTS.autoDownloadAssets,
      tempoConform: ['ask', 'always', 'never'].includes(stored.tempoConform as string)
        ? (stored.tempoConform as TempoConformChoice)
        : DEFAULTS.tempoConform
    }
    this.emit()
  }

  get middleClickPing(): boolean {
    return this.prefs.middleClickPing
  }

  get autoDownloadAssets(): boolean {
    return this.prefs.autoDownloadAssets
  }

  get tempoConform(): TempoConformChoice {
    return this.prefs.tempoConform
  }

  set<K extends keyof Preferences>(key: K, value: Preferences[K]): void {
    if (this.prefs[key] === value) return
    this.prefs = { ...this.prefs, [key]: value }
    void appStorageSet(STORAGE_KEY, this.prefs)
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

export const preferences = new PreferencesStore()

export function usePreferences(): number {
  return useSyncExternalStore(preferences.subscribe, preferences.getVersion)
}
