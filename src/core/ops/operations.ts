import type {
  AutomationPoint,
  AutomationPointId,
  ChatMessage,
  Clip,
  ClipId,
  Comment,
  CommentId,
  FileNode,
  FileNodeId,
  Track,
  TrackId
} from '../model/types'

/**
 * Every mutation of project state is expressed as one of these operations.
 * Operations are plain serializable data: the same objects drive local edits,
 * undo/redo, the activity feed, and (later) real-time network sync. Nothing
 * in the app mutates project state except by dispatching an Operation.
 */
export type Operation =
  | { type: 'project/rename'; name: string }
  | { type: 'project/setTempo'; tempo: number }
  /** `clips`/`automation` restore a deleted track's content on undo; empty for new tracks. */
  | { type: 'track/create'; track: Track; index: number; clips: Clip[]; automation: AutomationPoint[] }
  | { type: 'track/delete'; trackId: TrackId }
  | { type: 'track/rename'; trackId: TrackId; name: string }
  | { type: 'track/setMute'; trackId: TrackId; muted: boolean }
  | { type: 'track/setSolo'; trackId: TrackId; soloed: boolean }
  | { type: 'track/setVolume'; trackId: TrackId; volume: number }
  | { type: 'track/setPan'; trackId: TrackId; pan: number }
  | { type: 'project/setMasterVolume'; volume: number }
  | { type: 'automation/add'; point: AutomationPoint }
  | { type: 'automation/move'; pointId: AutomationPointId; ticks: number; value: number }
  | { type: 'automation/delete'; pointId: AutomationPointId }
  | { type: 'track/reorder'; trackId: TrackId; index: number }
  | { type: 'clip/create'; clip: Clip }
  | { type: 'clip/delete'; clipId: ClipId }
  | { type: 'clip/move'; clipId: ClipId; trackId: TrackId; start: number }
  | { type: 'clip/resize'; clipId: ClipId; start: number; duration: number; offset: number }
  | { type: 'clip/rename'; clipId: ClipId; name: string }
  /** Plural so that undoing a subtree delete restores everything in one op. */
  | { type: 'file/create'; nodes: FileNode[] }
  /** Deletes each node AND its descendants. */
  | { type: 'file/delete'; nodeIds: FileNodeId[] }
  | { type: 'file/rename'; nodeId: FileNodeId; name: string }
  | { type: 'file/move'; nodeId: FileNodeId; parentId: FileNodeId | null }
  /** Conversation: chat is append-only and NOT undoable (invert = null). */
  | { type: 'chat/post'; message: ChatMessage }
  /** Plural so undoing a thread delete restores root + replies in one op. */
  | { type: 'comment/add'; comments: Comment[] }
  /** Deletes the comment and, for a thread root, all its replies. */
  | { type: 'comment/delete'; commentId: CommentId }
  | { type: 'comment/setResolved'; commentId: CommentId; resolved: boolean }

/** Wire/log format: an operation plus provenance metadata. */
export interface OpEnvelope {
  readonly id: string
  readonly userId: string
  readonly time: number
  readonly op: Operation
}
