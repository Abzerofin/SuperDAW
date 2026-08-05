import type { TimeSignature } from './timebase'

export type TrackId = string
export type ClipId = string
export type FileNodeId = string
export type TrackKind = 'audio' | 'midi'
export type FileNodeKind = 'folder' | 'audio' | 'midi'

/**
 * One entry in the File Bay: a folder or an asset reference. The bay's
 * structure is project document state (synced, undoable); asset binaries
 * are not. Deleting a bay entry never touches clips — clips reference
 * assets directly by id.
 */
export interface FileNode {
  readonly id: FileNodeId
  /** null = bay root. */
  readonly parentId: FileNodeId | null
  readonly kind: FileNodeKind
  readonly name: string
  /** Asset reference for audio/midi entries; null for folders. */
  readonly assetId: string | null
}

export interface Clip {
  readonly id: ClipId
  readonly trackId: TrackId
  readonly name: string
  /** Timeline position in ticks. */
  readonly start: number
  /** Length in ticks. */
  readonly duration: number
  /**
   * Audio asset this clip plays, or null (empty/MIDI clip). Asset binary
   * data is a separate system from project state (see ARCHITECTURE.md);
   * the document only ever references assets by id.
   */
  readonly assetId: string | null
  /** Offset into the source material, in ticks (grows when trimming the left edge). */
  readonly offset: number
  /** null = inherit the track color. */
  readonly color: string | null
}

export interface Track {
  readonly id: TrackId
  readonly kind: TrackKind
  readonly name: string
  readonly color: string
  readonly muted: boolean
  readonly soloed: boolean
}

export interface ProjectState {
  readonly name: string
  readonly tempo: number
  readonly timeSignature: TimeSignature
  readonly tracks: Readonly<Record<TrackId, Track>>
  readonly trackOrder: readonly TrackId[]
  readonly clips: Readonly<Record<ClipId, Clip>>
  readonly files: Readonly<Record<FileNodeId, FileNode>>
}

export function createEmptyProject(name: string): ProjectState {
  return {
    name,
    tempo: 120,
    timeSignature: [4, 4],
    tracks: {},
    trackOrder: [],
    clips: {},
    files: {}
  }
}

export function clipsOfTrack(state: ProjectState, trackId: TrackId): Clip[] {
  return Object.values(state.clips).filter((c) => c.trackId === trackId)
}

export function childrenOf(state: ProjectState, parentId: FileNodeId | null): FileNode[] {
  return Object.values(state.files).filter((n) => n.parentId === parentId)
}

/** True if `nodeId` is `ancestorId` or lies anywhere under it. */
export function isSelfOrDescendant(
  state: ProjectState,
  nodeId: FileNodeId,
  ancestorId: FileNodeId
): boolean {
  let current: FileNodeId | null = nodeId
  while (current !== null) {
    if (current === ancestorId) return true
    current = state.files[current]?.parentId ?? null
  }
  return false
}

/** A node plus all its descendants (folders recurse). */
export function subtreeOf(state: ProjectState, nodeId: FileNodeId): FileNode[] {
  const root = state.files[nodeId]
  if (!root) return []
  const out: FileNode[] = [root]
  const queue: FileNodeId[] = [nodeId]
  while (queue.length > 0) {
    const parentId = queue.shift()!
    for (const child of childrenOf(state, parentId)) {
      out.push(child)
      queue.push(child.id)
    }
  }
  return out
}
