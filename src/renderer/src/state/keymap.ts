import { useSyncExternalStore } from 'react'
import { appStorageGet, appStorageSet } from './appStorage'

/**
 * Rebindable keyboard shortcuts. The ROSTER (what actions exist, their
 * default combos) is code; the user's OVERRIDES are app-level state
 * persisted through the appStorage seam — personal, never part of any
 * document, synced to no one (exactly like the theme).
 *
 * A combo serializes as `Ctrl+Shift+K` (`Ctrl` matches Cmd on mac). The
 * resolver builds one combo→action map from defaults + overrides; global
 * and per-surface handlers ask `keymap.resolve(event)` instead of matching
 * keys themselves, so a rebinding applies everywhere the action fires.
 * Fixed ALIASES (e.g. Ctrl+Y for redo, Delete/Backspace) stay bound in
 * addition to the primary combo and are not rebindable.
 */

export type ShortcutId =
  | 'palette.toggle'
  | 'project.new'
  | 'project.open'
  | 'project.save'
  | 'project.saveAs'
  | 'transport.playPause'
  | 'transport.returnToStart'
  | 'transport.record'
  | 'transport.panic'
  | 'edit.undo'
  | 'edit.redo'
  | 'clip.copy'
  | 'clip.cut'
  | 'clip.paste'
  | 'clip.duplicate'
  | 'clip.split'
  | 'clip.comment'
  | 'track.duplicate'
  | 'track.mute'
  | 'track.monitor'
  | 'track.loop'
  | 'notes.quantize'
  | 'notes.humanize'
  | 'selection.all'
  | 'selection.delete'

export interface ShortcutDef {
  readonly id: ShortcutId
  readonly label: string
  readonly category: string
  /** Default combo (rebindable). */
  readonly combo: string
  /** Extra combos that always stay bound (not rebindable). */
  readonly aliases?: readonly string[]
}

export const SHORTCUT_DEFS: readonly ShortcutDef[] = [
  { id: 'transport.playPause', label: 'Play / stop (return to play start)', category: 'Transport', combo: 'Space' },
  { id: 'transport.returnToStart', label: 'Stop and return to the beginning', category: 'Transport', combo: 'Shift+Space' },
  { id: 'transport.record', label: 'Record / stop recording', category: 'Transport', combo: 'R' },
  { id: 'transport.panic', label: 'All notes off (panic)', category: 'Transport', combo: 'Ctrl+.' },

  { id: 'project.save', label: 'Save project', category: 'Project', combo: 'Ctrl+S' },
  { id: 'project.saveAs', label: 'Save project as…', category: 'Project', combo: 'Ctrl+Shift+S' },
  { id: 'project.open', label: 'Open project…', category: 'Project', combo: 'Ctrl+O' },
  { id: 'project.new', label: 'New project', category: 'Project', combo: 'Ctrl+Shift+N' },
  { id: 'palette.toggle', label: 'Command palette', category: 'Project', combo: 'Ctrl+P' },

  { id: 'edit.undo', label: 'Undo', category: 'Editing', combo: 'Ctrl+Z' },
  { id: 'edit.redo', label: 'Redo', category: 'Editing', combo: 'Ctrl+Shift+Z', aliases: ['Ctrl+Y'] },
  { id: 'clip.copy', label: 'Copy clip', category: 'Editing', combo: 'Ctrl+C' },
  { id: 'clip.cut', label: 'Cut clip', category: 'Editing', combo: 'Ctrl+X' },
  { id: 'clip.paste', label: 'Paste clip', category: 'Editing', combo: 'Ctrl+V' },
  { id: 'clip.duplicate', label: 'Duplicate clip', category: 'Editing', combo: 'D', aliases: ['Ctrl+D'] },
  { id: 'track.duplicate', label: 'Duplicate track', category: 'Editing', combo: 'Shift+D', aliases: ['Ctrl+Shift+D'] },
  { id: 'clip.split', label: 'Split clip at playhead', category: 'Editing', combo: 'S', aliases: ['Ctrl+E'] },
  { id: 'selection.all', label: 'Select all clips (widen selection)', category: 'Editing', combo: 'Shift+A' },
  { id: 'selection.delete', label: 'Delete selected clips', category: 'Editing', combo: 'Delete', aliases: ['Backspace'] },

  { id: 'track.mute', label: 'Mute selected track', category: 'Tools', combo: 'M' },
  { id: 'track.monitor', label: 'Toggle input monitoring', category: 'Tools', combo: 'I' },
  { id: 'track.loop', label: 'Loop selected track (audition)', category: 'Tools', combo: 'L' },
  { id: 'notes.quantize', label: 'Quantize selected notes', category: 'Tools', combo: 'Q' },
  { id: 'notes.humanize', label: 'Humanize selected notes', category: 'Tools', combo: 'H' },
  { id: 'clip.comment', label: 'Comment on selected clip', category: 'Tools', combo: 'C' }
]

const DEF_BY_ID = new Map(SHORTCUT_DEFS.map((def) => [def.id, def]))

/** Normalize a KeyboardEvent into a combo string; null for bare modifiers. */
export function comboFromEvent(e: KeyboardEvent): string | null {
  const key = e.key
  if (key === 'Control' || key === 'Shift' || key === 'Alt' || key === 'Meta') return null
  const parts: string[] = []
  if (e.ctrlKey || e.metaKey) parts.push('Ctrl')
  if (e.altKey) parts.push('Alt')
  if (e.shiftKey) parts.push('Shift')
  parts.push(normalizeKey(key))
  return parts.join('+')
}

function normalizeKey(key: string): string {
  if (key === ' ') return 'Space'
  if (key.length === 1) return key.toUpperCase()
  return key
}

/** A combo the pane can display and the loader can trust. */
function isValidCombo(combo: string): boolean {
  const parts = combo.split('+')
  const key = parts[parts.length - 1]
  if (!key) return false
  return parts.slice(0, -1).every((part) => part === 'Ctrl' || part === 'Alt' || part === 'Shift')
}

const STORAGE_KEY = 'keymap'

class KeymapStore {
  /** User overrides only (id → combo); defaults live in SHORTCUT_DEFS. */
  private overrides: Record<string, string> = {}
  /** combo → the action it triggers, rebuilt on every change. */
  private byCombo = new Map<string, ShortcutId>()
  /** Actions whose PRIMARY combo lost a collision (shown in the pane). */
  private shadowed = new Map<ShortcutId, ShortcutId>()

  private version = 0
  private listeners = new Set<() => void>()

  constructor() {
    this.rebuild()
    void this.init()
  }

  private async init(): Promise<void> {
    const stored = await appStorageGet<Record<string, string>>(STORAGE_KEY)
    if (!stored || typeof stored !== 'object') return
    const overrides: Record<string, string> = {}
    for (const [id, combo] of Object.entries(stored)) {
      if (DEF_BY_ID.has(id as ShortcutId) && typeof combo === 'string' && isValidCombo(combo)) {
        overrides[id] = combo
      }
    }
    this.overrides = overrides
    this.rebuild()
    this.emit()
  }

  /** The combo that currently triggers `id`. */
  comboFor(id: ShortcutId): string {
    return this.overrides[id] ?? DEF_BY_ID.get(id)!.combo
  }

  isOverridden(id: ShortcutId): boolean {
    return id in this.overrides
  }

  /** The action whose binding shadows this one's, or null if active. */
  shadowedBy(id: ShortcutId): ShortcutDef | null {
    const winner = this.shadowed.get(id)
    return winner ? DEF_BY_ID.get(winner)! : null
  }

  /** What a keydown means under the current map (null = nothing bound). */
  resolve(e: KeyboardEvent): ShortcutId | null {
    const combo = comboFromEvent(e)
    return combo ? (this.byCombo.get(combo) ?? null) : null
  }

  set(id: ShortcutId, combo: string): void {
    if (!DEF_BY_ID.has(id) || !isValidCombo(combo)) return
    if (combo === DEF_BY_ID.get(id)!.combo) delete this.overrides[id]
    else this.overrides[id] = combo
    this.persist()
  }

  reset(id: ShortcutId): void {
    if (!(id in this.overrides)) return
    delete this.overrides[id]
    this.persist()
  }

  resetAll(): void {
    if (Object.keys(this.overrides).length === 0) return
    this.overrides = {}
    this.persist()
  }

  private persist(): void {
    this.rebuild()
    void appStorageSet(STORAGE_KEY, this.overrides)
    this.emit()
  }

  /**
   * Rebuild combo→action. Passes order the precedence: fixed aliases first,
   * then default combos, then user overrides — so a user-chosen combo
   * always wins a collision, and whoever lost is recorded for the pane.
   */
  private rebuild(): void {
    this.byCombo = new Map()
    this.shadowed = new Map()
    // Fixed aliases first (no shadow bookkeeping — losing an alias never
    // deactivates an action whose primary combo still works).
    for (const def of SHORTCUT_DEFS) {
      for (const alias of def.aliases ?? []) {
        if (!this.byCombo.has(alias)) this.byCombo.set(alias, def.id)
      }
    }
    // Default primaries next; an unresolvable claim marks the def shadowed.
    for (const def of SHORTCUT_DEFS) {
      if (def.id in this.overrides) continue
      const holder = this.byCombo.get(def.combo)
      if (holder === undefined || holder === def.id) this.byCombo.set(def.combo, def.id)
      else this.shadowed.set(def.id, holder)
    }
    // User overrides win everything; whoever held the combo BY PRIMARY is
    // now shadowed (an evicted alias costs nothing — the primary remains).
    for (const [id, combo] of Object.entries(this.overrides)) {
      const holder = this.byCombo.get(combo)
      if (holder !== undefined && holder !== id && this.comboFor(holder) === combo) {
        this.shadowed.set(holder, id as ShortcutId)
      }
      this.byCombo.set(combo, id as ShortcutId)
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

export const keymap = new KeymapStore()

export function useKeymap(): number {
  return useSyncExternalStore(keymap.subscribe, keymap.getVersion)
}
