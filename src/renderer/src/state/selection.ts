import { useSyncExternalStore } from 'react'
import type { ClipId } from '@core/model/types'

/**
 * Clip selection. Ephemeral per-user UI state — deliberately outside the
 * project store (a collaborator's selection is presence data, not document
 * data). Lives in its own tiny store so global shortcuts (Delete) and the
 * timeline can share it.
 */
class SelectionStore {
  private clipId: ClipId | null = null
  private listeners = new Set<() => void>()

  get selectedClipId(): ClipId | null {
    return this.clipId
  }

  select(clipId: ClipId | null): void {
    if (this.clipId === clipId) return
    this.clipId = clipId
    for (const listener of this.listeners) listener()
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
}

export const selection = new SelectionStore()

export function useSelectedClipId(): ClipId | null {
  return useSyncExternalStore(selection.subscribe, () => selection.selectedClipId)
}
