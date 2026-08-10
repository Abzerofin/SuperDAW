import type { TimeSignature } from '../model/timebase'
import type { ProjectSettings } from '../model/projectSettings'
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
  Route,
  RouteId,
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
  /** Replaces the whole lyrics text — one edit session, one op. */
  | { type: 'project/setLyrics'; lyrics: string }
  /**
   * `conform` present = the gesture also stretched audio clips so their
   * material keeps filling the same bars at the new tempo (tape-style
   * resampling). Absolute stretch factors — re-delivery is idempotent —
   * and entries whose clip is gone are skipped individually.
   */
  | {
      type: 'project/setTempo'
      tempo: number
      conform?: Array<{ clipId: ClipId; stretch: number }>
    }
  | { type: 'project/setTimeSignature'; timeSignature: TimeSignature }
  /**
   * Update project-scoped settings (core/model/projectSettings). The patch
   * carries ABSOLUTE values for the fields it touches — idempotent on
   * re-delivery, per-field last-write-wins between peers. One settings
   * gesture = one patch; the invert is the previous values of the same keys.
   */
  | { type: 'project/updateSettings'; patch: Partial<ProjectSettings> }
  /**
   * Content arrays restore a deleted track on undo; all empty for new
   * tracks. `descendants` restores a deleted folder's subtree (each track
   * at its original trackOrder index) — absent for single tracks.
   */
  | {
      type: 'track/create'
      track: Track
      index: number
      clips: Clip[]
      automation: AutomationPoint[]
      notes: Note[]
      plugins: PluginInstance[]
      /** Routing-graph edges of the restored subtree (absent for new tracks). */
      routes?: Route[]
      descendants?: Array<{ track: Track; index: number }>
    }
  /** Deletes the track AND, for folders, every descendant track. */
  | { type: 'track/delete'; trackId: TrackId }
  /** Move a track into a folder (null = root). Reducer rejects cycles/non-folders. */
  | { type: 'track/setParent'; trackId: TrackId; parentId: TrackId | null }
  /**
   * Freeze: playback switches to a pre-rendered asset (see Track.frozenAssetId).
   * The asset is rendered locally BEFORE dispatch and carried by id, so every
   * peer flips to the same audio (transferred via the normal asset machinery).
   */
  | { type: 'track/freeze'; trackId: TrackId; assetId: string }
  | { type: 'track/unfreeze'; trackId: TrackId }
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
  /** Move a whole multi-selection in one gesture = one op (absolute, idempotent). */
  | { type: 'note/moveMany'; moves: Array<{ noteId: NoteId; pitch: number; start: number }> }
  /** `start` present = the LEFT edge moved too (duration and start in one op). */
  | { type: 'note/resize'; noteId: NoteId; duration: number; start?: number }
  | { type: 'note/setVelocity'; noteId: NoteId; velocity: number }
  /** Plural: multi-delete and thread restores stay one undoable op. */
  | { type: 'note/delete'; noteIds: NoteId[] }
  | { type: 'note/addMany'; notes: Note[] }
  /** `routes` restores the instance's graph connections on undo of a remove. */
  | {
      type: 'plugin/add'
      instance: PluginInstance
      routes?: Route[]
      /** Parameter automation of a removed insert, restored on undo. */
      automation?: AutomationPoint[]
      /**
       * Edges this add replaces — splicing the node into a live graph in
       * series removes the edges it now sits on (e.g. every X→out becomes
       * X→new, new→out). Full routes, not ids, so undo can restore them.
       */
      severedRoutes?: Route[]
    }
  /**
   * Also cascades away every route touching the instance (see invert).
   * `restoreRoutes` re-adds the edges a spliced-in add severed, so undoing
   * that add heals the graph it rewired.
   */
  | { type: 'plugin/remove'; instanceId: PluginInstanceId; restoreRoutes?: Route[] }
  /**
   * Effect ROUTING GRAPH edges (see Route). Plural like note/delete: a
   * gesture that materializes a chain or clears a graph stays one op.
   * The reducer validates each edge against the evolving state (unknown
   * endpoints, duplicates and cycles are skipped individually).
   */
  | { type: 'route/addMany'; routes: Route[] }
  | { type: 'route/deleteMany'; routeIds: RouteId[] }
  /** Node position in the graph editor (document data, like clip colors). */
  | { type: 'plugin/setGraphPos'; instanceId: PluginInstanceId; x: number; y: number }
  /** Position of a track's In / Mix Out terminal in the graph editor. */
  | {
      type: 'track/setGraphTerminal'
      trackId: TrackId
      terminal: 'in' | 'out'
      x: number
      y: number
    }
  | { type: 'plugin/setParam'; instanceId: PluginInstanceId; param: string; value: number }
  /**
   * Set several params atomically — for gestures that move more than one
   * value at once (dragging an EQ band point changes freq AND gain), so
   * one gesture stays one operation.
   */
  | { type: 'plugin/setParams'; instanceId: PluginInstanceId; params: Record<string, number> }
  | { type: 'plugin/setEnabled'; instanceId: PluginInstanceId; enabled: boolean }
  /**
   * Whole-chain order for one track, so a reorder drag stays ONE op and
   * stays idempotent (re-applying assigns identical ranks). Ids that are
   * unknown or belong to another track are skipped; chain members absent
   * from `order` keep their relative order at the end, so a concurrent
   * `plugin/add` on a peer is never dropped.
   */
  | { type: 'plugin/reorder'; trackId: TrackId; order: PluginInstanceId[] }
  /**
   * Opaque serialized plugin state (external formats: the component's
   * state chunk, base64 inside a small JSON envelope). Captured when a
   * plugin's own editor closes; peers WITHOUT the plugin still carry the
   * blob intact, so nothing diverges. Null clears it.
   */
  | { type: 'plugin/setState'; instanceId: PluginInstanceId; stateBlob: string | null }
  | { type: 'track/setSynthParam'; trackId: TrackId; param: string; value: number }
  /**
   * Set several synth params atomically — re-adding a removed instrument
   * restores presence, bypass and its sound in one undoable step.
   */
  | { type: 'track/setSynthParams'; trackId: TrackId; params: Record<string, number> }
  /** `parentId` present = also re-parent in the same gesture (drag into a folder). */
  | { type: 'track/reorder'; trackId: TrackId; index: number; parentId?: TrackId | null }
  /**
   * Wrap existing tracks in a NEW folder bus — one gesture, one op, because
   * creating the folder and re-parenting the tracks must not be separately
   * undoable (an undo landing between them would leave an orphan folder).
   * The folder is inserted at `index`; the tracks follow it in `trackIds`
   * order. Inverted by `track/ungroup`.
   */
  | { type: 'track/group'; folder: Track; index: number; trackIds: TrackId[] }
  /**
   * Remove a folder and put its children back where they were. `restore`
   * carries each child's previous parent and trackOrder index so the
   * inverse of `track/group` is exact; children NOT listed keep the
   * folder's own parent (a peer may have added one concurrently).
   */
  | {
      type: 'track/ungroup'
      folderId: TrackId
      restore: Array<{ trackId: TrackId; parentId: TrackId | null; index: number }>
    }
  /** `notes` seeds MIDI content (import, undo-restore); empty for new clips. */
  | { type: 'clip/create'; clip: Clip; notes: Note[] }
  | { type: 'clip/delete'; clipId: ClipId }
  /** Delete a multi-clip selection as one undoable step. */
  | { type: 'clip/deleteMany'; clipIds: ClipId[] }
  /** Restore several clips with their notes — the inverse of the above. */
  | { type: 'clip/createMany'; clips: Clip[]; notes: Note[] }
  | { type: 'clip/move'; clipId: ClipId; trackId: TrackId; start: number }
  /**
   * `loopLength` present = the gesture also set the loop period (the loop
   * handle extends duration and establishes the period in ONE op; 0 turns
   * looping off). `stretch` present = the gesture time-scaled the material
   * to fill the new duration (the stretch handle: longer = slower). Absent
   * fields = plain trim, that state untouched.
   */
  | {
      type: 'clip/resize'
      clipId: ClipId
      start: number
      duration: number
      offset: number
      loopLength?: number
      stretch?: number
    }
  /**
   * Move several clips at once — dragging a multi-clip selection. Absolute
   * destinations (not deltas), so re-delivery is idempotent. Entries whose
   * clip or target track is unusable are skipped individually; the rest
   * still land.
   */
  | {
      type: 'clip/moveMany'
      moves: Array<{ clipId: ClipId; trackId: TrackId; start: number }>
    }
  /** Resize/trim/loop/stretch several clips at once. See `clip/resize`. */
  | {
      type: 'clip/resizeMany'
      edits: Array<{
        clipId: ClipId
        start: number
        duration: number
        offset: number
        loopLength?: number
        stretch?: number
      }>
    }
  /**
   * Restore a clip to an earlier state of ITSELF (the per-item history).
   * Carries the full field set — absolute, so re-delivery is idempotent
   * and the invert is simply the current field set. The id must already
   * exist (deleted clips restore through undo, not item history); the
   * stored trackId is honored only if that track still exists. Notes are
   * their own entities and deliberately not part of this.
   */
  | { type: 'clip/restore'; clipId: ClipId; clip: Clip }
  /**
   * Restore a track's own knobs — name, color, mute/solo, volume, pan,
   * synth — from its item history. Structure (kind, parent, freeze) and
   * content stay untouched.
   */
  | {
      type: 'track/restore'
      trackId: TrackId
      track: {
        name: string
        color: string
        muted: boolean
        soloed: boolean
        volume: number
        pan: number
        synth: Readonly<Record<string, number>>
      }
    }
  /**
   * Restore an insert's sound — params, bypass, state chunk — from its
   * item history. Rank and graph position stay where they are.
   */
  | {
      type: 'plugin/restore'
      instanceId: PluginInstanceId
      params: Record<string, number>
      enabled: boolean
      stateBlob: string | null
    }
  | { type: 'clip/rename'; clipId: ClipId; name: string }
  /** null = revert to the track color. */
  | { type: 'clip/setColor'; clipId: ClipId; color: string | null }
  /** Fade lengths in ticks; the reducer clamps so fadeIn + fadeOut <= duration. */
  | { type: 'clip/setFades'; clipId: ClipId; fadeIn: number; fadeOut: number }
  /**
   * How the clip's source material is played back: backwards, transposed
   * and/or time-scaled. Carried together (like fades) because they are one
   * family of sample-playback settings; each UI gesture sends the current
   * value of the others.
   */
  | { type: 'clip/setPlayback'; clipId: ClipId; reverse: boolean; pitch: number; stretch: number }
  /**
   * Cut a clip in two at an absolute tick position. `rightName`/`rightColor`/
   * `leftDuration`/`rightFades`/`leftFadeOut` exist so that inverting a
   * `clip/merge` reconstructs the original right clip (and any gap/fades)
   * exactly; interactive splits omit them (fade-out then belongs to the
   * right half, and the cut point itself is fade-free).
   */
  | {
      type: 'clip/split'
      clipId: ClipId
      at: number
      rightClipId: ClipId
      rightName?: string
      rightColor?: string | null
      leftDuration?: number
      rightFades?: readonly [fadeIn: number, fadeOut: number]
      leftFadeOut?: number
    }
  /** Extend `clipId` over `rightClipId` and absorb its notes (undo of split). */
  | { type: 'clip/merge'; clipId: ClipId; rightClipId: ClipId }
  /**
   * Cut clips at several points in one gesture (slice into N equal parts,
   * or slice a whole selection at the playhead). Each entry cuts one clip
   * at ascending absolute tick positions; `newClipIds[i]` names the piece
   * created by cut `i`, so every peer mints the same ids. Idempotent:
   * re-delivery finds the pieces already there and does nothing.
   */
  | {
      type: 'clip/slice'
      slices: Array<{ clipId: ClipId; at: number[]; newClipIds: ClipId[] }>
    }
  /** Absorb sliced pieces back into their source clip — inverts the above. */
  | {
      type: 'clip/unslice'
      merges: Array<{ clipId: ClipId; pieceIds: ClipId[] }>
    }
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
  /**
   * Present when the op came from the history stack rather than a fresh
   * gesture. Peers can only label it honestly with this — an undo travels
   * as its inverse op, which is indistinguishable from a plain edit.
   */
  readonly intent?: 'undo' | 'redo'
}
