import { useSyncExternalStore } from 'react'

/** Command palette visibility (Ctrl+P) — ephemeral UI state. */
class PaletteUiStore {
  isOpen = false

  private version = 0
  private listeners = new Set<() => void>()

  open(): void {
    if (this.isOpen) return
    this.isOpen = true
    this.emit()
  }

  close(): void {
    if (!this.isOpen) return
    this.isOpen = false
    this.emit()
  }

  toggle(): void {
    this.isOpen = !this.isOpen
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

export const paletteUi = new PaletteUiStore()

export function usePaletteUi(): PaletteUiStore {
  useSyncExternalStore(paletteUi.subscribe, paletteUi.getVersion)
  return paletteUi
}
