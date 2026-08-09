import { useSyncExternalStore } from 'react'
import { appStorageGet, appStorageSet } from './appStorage'

/**
 * UI theme selection — app-level state, persisted via appStorage, never
 * part of a project document (collaborators in the same session each keep
 * their own look; nothing about a theme is sent over the wire).
 *
 * A theme is two attributes on <html>: `data-theme` picks the palette and
 * `data-shell` picks the surface treatment — 'plain' keeps the stock
 * straight-edged panels, 'analog' machines every division into hardware
 * grooves on light cream panels (styles/analog.css, which also carries the
 * corrections a light background needs). Splitting palette from shell means
 * a new palette can reuse a shell without duplicating its shape CSS.
 *
 * appStorage is async (Electron writes a JSON file under userData), which
 * would flash the default theme on every boot, so the choice is mirrored
 * into localStorage and applied synchronously at module load — before
 * React's first paint. appStorage stays the source of truth.
 */

export type ThemeId = 'graphite' | 'cassette' | 'formica'

export type ThemeShell = 'plain' | 'analog'

export interface ThemeInfo {
  readonly id: ThemeId
  readonly label: string
  readonly description: string
  readonly shell: ThemeShell
}

export const THEMES: readonly ThemeInfo[] = [
  {
    id: 'graphite',
    label: 'Graphite',
    description: 'The stock desk: flat panels, straight borders, nothing in the way.',
    shell: 'plain'
  },
  {
    id: 'cassette',
    label: 'Cassette',
    description: 'Bone-cream tape deck. Burnt orange, warm ink, screen-printed legends.',
    shell: 'analog'
  },
  {
    id: 'formica',
    label: 'Formica',
    description: 'Pale mint laminate off a combo organ — faded teal, mustard, no glow.',
    shell: 'analog'
  }
]

export const DEFAULT_THEME: ThemeId = 'graphite'

function themeInfo(id: ThemeId): ThemeInfo {
  return THEMES.find((t) => t.id === id) ?? THEMES[0]
}

function isThemeId(value: unknown): value is ThemeId {
  return THEMES.some((t) => t.id === value)
}

const STORAGE_KEY = 'theme'
/** Synchronous boot mirror; appStorage remains authoritative. */
const MIRROR_KEY = 'superdaw.theme.mirror'

interface StoredTheme {
  themeId: ThemeId
}

function readMirror(): StoredTheme | null {
  try {
    const raw = localStorage.getItem(MIRROR_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<StoredTheme>
    if (!isThemeId(parsed.themeId)) return null
    return { themeId: parsed.themeId }
  } catch {
    return null
  }
}

function writeMirror(value: StoredTheme): void {
  try {
    localStorage.setItem(MIRROR_KEY, JSON.stringify(value))
  } catch {
    // A blocked localStorage only costs a one-frame flash at next boot.
  }
}

/** Stamp the choice onto <html>; every theme rule keys off these. */
function applyToDocument(themeId: ThemeId): void {
  // Guarded so importing this module under the (DOM-less) test runner is safe.
  if (typeof document === 'undefined') return
  const root = document.documentElement
  root.dataset.theme = themeId
  root.dataset.shell = themeInfo(themeId).shell
}

class ThemeStore {
  themeId: ThemeId = DEFAULT_THEME

  private version = 0
  private listeners = new Set<() => void>()

  constructor() {
    const mirror = readMirror()
    if (mirror) this.themeId = mirror.themeId
    applyToDocument(this.themeId)
    void this.init()
  }

  /** The authoritative read; reconciles a stale or missing mirror. */
  private async init(): Promise<void> {
    const stored = await appStorageGet<Partial<StoredTheme>>(STORAGE_KEY)
    if (!stored) return
    // A stored id from a removed theme falls back to the default.
    const themeId = isThemeId(stored.themeId) ? stored.themeId : DEFAULT_THEME
    if (themeId === this.themeId) return
    this.themeId = themeId
    this.commit()
  }

  get shell(): ThemeShell {
    return themeInfo(this.themeId).shell
  }

  get info(): ThemeInfo {
    return themeInfo(this.themeId)
  }

  setTheme(themeId: ThemeId): void {
    if (!isThemeId(themeId) || themeId === this.themeId) return
    this.themeId = themeId
    this.commit()
  }

  private commit(): void {
    applyToDocument(this.themeId)
    const value: StoredTheme = { themeId: this.themeId }
    writeMirror(value)
    void appStorageSet(STORAGE_KEY, value)
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

export const theme = new ThemeStore()

export function useTheme(): ThemeStore {
  useSyncExternalStore(theme.subscribe, theme.getVersion)
  return theme
}
