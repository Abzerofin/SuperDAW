import { useSyncExternalStore } from 'react'
import type { ClipId, TrackId } from '@core/model/types'

/**
 * Clip + track selection. Ephemeral per-user UI state — deliberately
 * outside the project store (a collaborator's selection is presence data,
 * not document data). Lives in its own tiny store so global shortcuts
 * (Delete), the timeline and the Effects dock can share it.
 *
 * Selection is a SET of clips and a SET of tracks so several can be edited
 * as one gesture. `selectedClipId` / `selectedTrackId` remain the "focused"
 * (most recently touched) member, which is what single-target UI — the
 * Effects dock, the piano roll, the clip menu — follows.
 *
 * Selecting a clip also selects its track, so the Effects dock follows
 * whatever the user is working on. Deselecting a clip deliberately does
 * NOT clear the track — closing a clip menu must not blank the effects
 * panel.
 */
class SelectionStore {
  private clipIds = new Set<ClipId>()
  private trackIds = new Set<TrackId>()
  /** The focused members: last clicked, and what single-target UI uses. */
  private clipId: ClipId | null = null
  private trackId: TrackId | null = null
  /**
   * Bumped on every change. The Set snapshots are mutable, so
   * useSyncExternalStore needs a value that changes identity per update.
   */
  private version = 0
  private listeners = new Set<() => void>()

  get selectedClipId(): ClipId | null {
    return this.clipId
  }

  get selectedTrackId(): TrackId | null {
    return this.trackId
  }

  get selectedClipIds(): ReadonlySet<ClipId> {
    return this.clipIds
  }

  get selectedTrackIds(): ReadonlySet<TrackId> {
    return this.trackIds
  }

  get snapshot(): number {
    return this.version
  }

  isClipSelected(clipId: ClipId): boolean {
    return this.clipIds.has(clipId)
  }

  isTrackSelected(trackId: TrackId): boolean {
    return this.trackIds.has(trackId)
  }

  /** Replace the clip selection with one clip (or clear it). */
  select(clipId: ClipId | null, trackId?: TrackId): void {
    const sameClip =
      this.clipId === clipId && this.clipIds.size === (clipId === null ? 0 : 1)
    if (sameClip && (trackId === undefined || this.trackId === trackId)) return
    this.clipIds = clipId === null ? new Set() : new Set([clipId])
    this.clipId = clipId
    if (trackId !== undefined) this.setTrackSelection(trackId)
    this.emit()
  }

  /**
   * Add or remove one clip (Ctrl/Cmd-click). Removing the focused clip
   * hands focus to any remaining member so single-target UI stays live.
   */
  toggleClip(clipId: ClipId, trackId?: TrackId): void {
    const next = new Set(this.clipIds)
    if (next.has(clipId)) {
      next.delete(clipId)
      if (this.clipId === clipId) this.clipId = next.values().next().value ?? null
    } else {
      next.add(clipId)
      this.clipId = clipId
      if (trackId !== undefined) this.setTrackSelection(trackId)
    }
    this.clipIds = next
    this.emit()
  }

  /** Select exactly these clips (marquee / select-all). */
  selectClips(clipIds: Iterable<ClipId>, focus?: ClipId): void {
    this.clipIds = new Set(clipIds)
    this.clipId = focus ?? this.clipIds.values().next().value ?? null
    this.emit()
  }

  /** Full reset — for a new/loaded project: neither clips nor tracks carry over. */
  clear(): void {
    if (
      this.clipIds.size === 0 &&
      this.clipId === null &&
      this.trackIds.size === 0 &&
      this.trackId === null
    )
      return
    this.clipIds = new Set()
    this.clipId = null
    this.trackIds = new Set()
    this.trackId = null
    this.emit()
  }

  selectTrack(trackId: TrackId | null): void {
    const same = this.trackId === trackId && this.trackIds.size === (trackId === null ? 0 : 1)
    if (same) return
    this.setTrackSelection(trackId)
    this.emit()
  }

  /** Add or remove one track (Ctrl/Cmd-click on its header). */
  toggleTrack(trackId: TrackId): void {
    const next = new Set(this.trackIds)
    if (next.has(trackId)) {
      next.delete(trackId)
      if (this.trackId === trackId) this.trackId = next.values().next().value ?? null
    } else {
      next.add(trackId)
      this.trackId = trackId
    }
    this.trackIds = next
    this.emit()
  }

  /** Select exactly these tracks (Shift-click range). */
  selectTracks(trackIds: Iterable<TrackId>, focus?: TrackId): void {
    this.trackIds = new Set(trackIds)
    this.trackId = focus ?? this.trackIds.values().next().value ?? null
    this.emit()
  }

  private setTrackSelection(trackId: TrackId | null): void {
    this.trackIds = trackId === null ? new Set() : new Set([trackId])
    this.trackId = trackId
  }

  private emit(): void {
    this.version++
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

/**
 * Subscribe to the whole selection. Returns the version counter — read the
 * sets off `selection` itself; they are replaced (never mutated) on change,
 * so reading after a re-render is always current.
 */
export function useSelectionVersion(): number {
  return useSyncExternalStore(selection.subscribe, () => selection.snapshot)
}
