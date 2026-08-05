import type { TimeSignature } from './timebase'
import type { PluginDescriptor } from '../plugins/descriptor'

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
  /** Fader gain, linear (1 = unity/0 dB). */
  readonly volume: number
  /** Stereo pan, -1 (L) .. 1 (R). */
  readonly pan: number
  /** Built-in synth parameters (MIDI tracks; empty for audio). See SYNTH_DEFS. */
  readonly synth: Readonly<Record<string, number>>
}

export type PluginInstanceId = string

/**
 * One insert in a track's chain: a use of a plugin, identified by
 * descriptor metadata (never a filesystem path — see core/plugins).
 * Chains sort by `rank`. Whether the plugin is actually available is a
 * per-client runtime question and lives outside the document.
 */
export interface PluginInstance {
  readonly id: PluginInstanceId
  readonly trackId: TrackId
  readonly descriptor: PluginDescriptor
  readonly enabled: boolean
  readonly rank: number
  readonly params: Readonly<Record<string, number>>
  /** Opaque serialized plugin chunk state (external formats); null for builtins. */
  readonly stateBlob: string | null
}

export const MAX_GAIN = 1.4 // ≈ +3 dB of headroom above unity

export type NoteId = string

/**
 * A MIDI note. `start` is relative to the owning clip's start, so moving
 * a clip carries its notes with zero note ops. Notes whose window falls
 * outside the clip's duration are clipped at playback (standard DAW
 * behavior when a clip is shortened).
 */
export interface Note {
  readonly id: NoteId
  readonly clipId: ClipId
  /** MIDI pitch 0..127 (60 = middle C). */
  readonly pitch: number
  /** Ticks from clip start. */
  readonly start: number
  readonly duration: number
  /** 1..127. */
  readonly velocity: number
}

export type AutomationParam = 'volume'
export type AutomationPointId = string

/**
 * One point on a track's automation curve. `value` is normalized 0..1 and
 * MULTIPLIES the fader (modulation semantics): 1 = fader level, 0 = silence.
 * Points between are linearly interpolated.
 */
export interface AutomationPoint {
  readonly id: AutomationPointId
  readonly trackId: TrackId
  readonly param: AutomationParam
  readonly ticks: number
  readonly value: number
}

export type CommentId = string
export type ChatMessageId = string

/** What a comment thread is attached to. Extend as new surfaces appear. */
export interface CommentAnchor {
  readonly kind: 'clip' | 'track' | 'file'
  readonly id: string
}

/**
 * Conversation data lives in the document: it syncs in sessions and
 * persists in project files, so a handed-off project carries its
 * discussion. Author names are snapshotted — peer ids are per-run and
 * the roster is ephemeral.
 */
export interface ChatMessage {
  readonly id: ChatMessageId
  readonly userId: string
  readonly authorName: string
  readonly time: number
  readonly text: string
}

export interface Comment {
  readonly id: CommentId
  /** Root comments carry the anchor; replies inherit via parentId. */
  readonly anchor: CommentAnchor
  readonly parentId: CommentId | null
  readonly userId: string
  readonly authorName: string
  readonly time: number
  readonly text: string
  readonly resolved: boolean
}

export interface ProjectState {
  readonly name: string
  readonly tempo: number
  readonly timeSignature: TimeSignature
  readonly tracks: Readonly<Record<TrackId, Track>>
  readonly trackOrder: readonly TrackId[]
  readonly clips: Readonly<Record<ClipId, Clip>>
  readonly files: Readonly<Record<FileNodeId, FileNode>>
  readonly chat: readonly ChatMessage[]
  readonly comments: Readonly<Record<CommentId, Comment>>
  readonly masterVolume: number
  readonly automation: Readonly<Record<AutomationPointId, AutomationPoint>>
  readonly notes: Readonly<Record<NoteId, Note>>
  readonly plugins: Readonly<Record<PluginInstanceId, PluginInstance>>
}

export function createEmptyProject(name: string): ProjectState {
  return {
    name,
    tempo: 120,
    timeSignature: [4, 4],
    tracks: {},
    trackOrder: [],
    clips: {},
    files: {},
    chat: [],
    comments: {},
    masterVolume: 1,
    automation: {},
    notes: {},
    plugins: {}
  }
}

/** A track's insert chain in processing order. */
export function pluginsOfTrack(state: ProjectState, trackId: TrackId): PluginInstance[] {
  return Object.values(state.plugins)
    .filter((p) => p.trackId === trackId)
    .sort((a, b) => a.rank - b.rank)
}

export function notesOfClip(state: ProjectState, clipId: ClipId): Note[] {
  return Object.values(state.notes)
    .filter((n) => n.clipId === clipId)
    .sort((a, b) => a.start - b.start || a.pitch - b.pitch)
}

/** A track's points for one parameter, in timeline order. */
export function automationOf(
  state: ProjectState,
  trackId: TrackId,
  param: AutomationParam
): AutomationPoint[] {
  return Object.values(state.automation)
    .filter((p) => p.trackId === trackId && p.param === param)
    .sort((a, b) => a.ticks - b.ticks)
}

/** Linear interpolation of a curve at a position; 1 (no modulation) if empty. */
export function automationValueAt(points: readonly AutomationPoint[], ticks: number): number {
  if (points.length === 0) return 1
  if (ticks <= points[0].ticks) return points[0].value
  const last = points[points.length - 1]
  if (ticks >= last.ticks) return last.value
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i]
    const b = points[i + 1]
    if (ticks >= a.ticks && ticks <= b.ticks) {
      const span = b.ticks - a.ticks
      const t = span === 0 ? 0 : (ticks - a.ticks) / span
      return a.value + (b.value - a.value) * t
    }
  }
  return last.value
}

/** Root comments (threads) attached to an anchor, oldest first. */
export function threadsFor(state: ProjectState, anchor: CommentAnchor): Comment[] {
  return Object.values(state.comments)
    .filter((c) => c.parentId === null && c.anchor.kind === anchor.kind && c.anchor.id === anchor.id)
    .sort((a, b) => a.time - b.time)
}

/** Replies to a root comment, oldest first. */
export function repliesTo(state: ProjectState, commentId: CommentId): Comment[] {
  return Object.values(state.comments)
    .filter((c) => c.parentId === commentId)
    .sort((a, b) => a.time - b.time)
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
