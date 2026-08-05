import type { TimeSignature } from '../model/timebase'
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
  Note,
  NoteId,
  PluginInstance,
  PluginInstanceId,
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
  | { type: 'project/setTimeSignature'; timeSignature: TimeSignature }
  /** Content arrays restore a deleted track on undo; all empty for new tracks. */
  | {
      type: 'track/create'
      track: Track
      index: number
      clips: Clip[]
      automation: AutomationPoint[]
      notes: Note[]
      plugins: PluginInstance[]
    }
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
  | { type: 'note/add'; note: Note }
  | { type: 'note/move'; noteId: NoteId; pitch: number; start: number }
  | { type: 'note/resize'; noteId: NoteId; duration: number }
  | { type: 'note/setVelocity'; noteId: NoteId; velocity: number }
  /** Plural: multi-delete and thread restores stay one undoable op. */
  | { type: 'note/delete'; noteIds: NoteId[] }
  | { type: 'note/addMany'; notes: Note[] }
  | { type: 'plugin/add'; instance: PluginInstance }
  | { type: 'plugin/remove'; instanceId: PluginInstanceId }
  | { type: 'plugin/setParam'; instanceId: PluginInstanceId; param: string; value: number }
  | { type: 'plugin/setEnabled'; instanceId: PluginInstanceId; enabled: boolean }
  | { type: 'track/setSynthParam'; trackId: TrackId; param: string; value: number }
  | { type: 'track/reorder'; trackId: TrackId; index: number }
  /** `notes` seeds MIDI content (import, undo-restore); empty for new clips. */
  | { type: 'clip/create'; clip: Clip; notes: Note[] }
  | { type: 'clip/delete'; clipId: ClipId }
  | { type: 'clip/move'; clipId: ClipId; trackId: TrackId; start: number }
  | { type: 'clip/resize'; clipId: ClipId; start: number; duration: number; offset: number }
  | { type: 'clip/rename'; clipId: ClipId; name: string }
  /** null = revert to the track color. */
  | { type: 'clip/setColor'; clipId: ClipId; color: string | null }
  /**
   * Cut a clip in two at an absolute tick position. `rightName`/`rightColor`/
   * `leftDuration` exist so that inverting a `clip/merge` reconstructs the
   * original right clip (and any gap) exactly; interactive splits omit them.
   */
  | {
      type: 'clip/split'
      clipId: ClipId
      at: number
      rightClipId: ClipId
      rightName?: string
      rightColor?: string | null
      leftDuration?: number
    }
  /** Extend `clipId` over `rightClipId` and absorb its notes (undo of split). */
  | { type: 'clip/merge'; clipId: ClipId; rightClipId: ClipId }
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
