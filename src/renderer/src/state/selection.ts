import { useSyncExternalStore } from 'react'
import type { ClipId, TrackId } from '@core/model/types'

/**
 * Clip + track selection. Ephemeral per-user UI state — deliberately
 * outside the project store (a collaborator's selection is presence data,
 * not document data). Lives in its own tiny store so global shortcuts
 * (Delete), the timeline and the Effects dock can share it.
 *
 * Selecting a clip also selects its track (pass `trackId`), so the
 * Effects dock follows whatever the user is working on. Deselecting a
 * clip deliberately does NOT clear the track — closing a clip menu must
 * not blank the effects panel.
 */
class SelectionStore {
  private clipId: ClipId | null = null
  private trackId: TrackId | null = null
  private listeners = new Set<() => void>()

  get selectedClipId(): ClipId | null {
    return this.clipId
  }

  get selectedTrackId(): TrackId | null {
    return this.trackId
  }

  select(clipId: ClipId | null, trackId?: TrackId): void {
    if (this.clipId === clipId && (trackId === undefined || this.trackId === trackId)) return
    this.clipId = clipId
    if (trackId !== undefined) this.trackId = trackId
    for (const listener of this.listeners) listener()
  }

  selectTrack(trackId: TrackId | null): void {
    if (this.trackId === trackId) return
    this.trackId = trackId
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

export function useSelectedTrackId(): TrackId | null {
  return useSyncExternalStore(selection.subscribe, () => selection.selectedTrackId)
}
