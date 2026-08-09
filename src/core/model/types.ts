import type { TimeSignature } from './timebase'
import type { PluginDescriptor } from '../plugins/descriptor'

export type TrackId = string
export type ClipId = string
export type FileNodeId = string
/** 'folder' tracks are grouping buses: no clips, children route through them. */
export type TrackKind = 'audio' | 'midi' | 'folder'
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
  /** Fade-in length in ticks from the clip start (0 = none). Audio clips only. */
  readonly fadeIn: number
  /** Fade-out length in ticks before the clip end (0 = none). Audio clips only. */
  readonly fadeOut: number
  /** Play the source material backwards. Audio clips only. */
  readonly reverse: boolean
  /**
   * Transposition in semitones (may be fractional). Implemented by
   * RESAMPLING, i.e. tape/sampler behaviour: pitching up also consumes the
   * source faster. Formant-preserving pitch shifting arrives with the
   * dedicated DSP milestone.
   */
  readonly pitch: number
  /**
   * Time factor for the source: 1 = original speed, 2 = plays half speed
   * (so the material covers twice the timeline), 0.5 = double speed. Also
   * resampling, so it transposes with the same tape behaviour.
   */
  readonly stretch: number
  /**
   * Loop period in ticks: 0 = no looping; otherwise the clip's material
   * repeats from its offset every `loopLength` ticks for the clip's whole
   * duration (the last repeat may be partial). Set by dragging the clip's
   * loop handle; a period >= the clip's duration plays like no loop.
   */
  readonly loopLength: number
}

/** Clamp bounds shared by the reducer and the UI controls. */
export const MIN_PITCH = -24
export const MAX_PITCH = 24
export const MIN_STRETCH = 0.25
export const MAX_STRETCH = 4
/** Shortest allowed loop period (guards div-by-zero and absurd tiling). */
export const MIN_LOOP_TICKS = 60

/** Clamp a loop period: 0 stays "off", anything else is floored at the minimum. */
export function normalizeLoop(loopLength: number): number {
  if (!Number.isFinite(loopLength) || loopLength <= 0) return 0
  return Math.max(MIN_LOOP_TICKS, Math.round(loopLength))
}

/** Whether a clip actually repeats (an over-long period plays straight through). */
export function isClipLooped(clip: Clip): boolean {
  return clip.loopLength >= MIN_LOOP_TICKS && clip.loopLength < clip.duration
}

/**
 * How fast a clip's buffer is read: semitone transposition and time factor
 * both land on the one resampling rate the audio primitives give us.
 * 1 = untouched. Pure so scheduling, rendering and the UI agree exactly.
 */
export function clipRate(clip: Clip): number {
  const stretch = clip.stretch > 0 ? clip.stretch : 1
  return Math.pow(2, clip.pitch / 12) / stretch
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
  /**
   * Enclosing folder track, or null at root. Sibling order derives from
   * `trackOrder`; the audio graph routes a child through its folder's
   * chain (folders are buses).
   */
  readonly parentId: TrackId | null
  /**
   * When set, the track is FROZEN: playback uses this rendered asset
   * (from tick 0, pre-fader: inserts + volume automation baked) and the
   * live clip/note/insert processing is skipped. The original content
   * stays fully intact in the document — unfreezing just clears this.
   */
  readonly frozenAssetId: string | null
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

/** Fader ceiling: +6 dB of headroom above unity. */
export const MAX_GAIN = 10 ** (6 / 20)

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

export type AutomationParam = 'volume' | 'pan'
export type AutomationPointId = string

/**
 * One point on a track's automation curve. `value` is normalized 0..1.
 * For 'volume' it MULTIPLIES the fader (modulation semantics): 1 = fader
 * level, 0 = silence. For 'pan' it maps linearly to stereo position:
 * 0 = hard left, 0.5 = center, 1 = hard right — and while pan automation
 * points exist they OWN the panner (the knob is overridden).
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
  /** ms epoch when the project was created; 0 = unknown (pre-metadata files). */
  readonly createdAt: number
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

export function createEmptyProject(name: string, createdAt = 0): ProjectState {
  return {
    name,
    createdAt,
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

/**
 * Whether a track's own fader should be open. Ancestor mutes are enforced
 * physically by folder-bus routing (the folder's fader closes), so this
 * answers only the per-track question: not muted, and — when any solo is
 * active anywhere — itself, an ancestor, or a descendant is soloed
 * (a folder bus must stay open for a soloed child inside it).
 */
export function isTrackAudible(state: ProjectState, trackId: TrackId): boolean {
  const track = state.tracks[trackId]
  if (!track || track.muted) return false
  const all = Object.values(state.tracks)
  if (!all.some((t) => t.soloed)) return true
  return all.some(
    (t) =>
      t.soloed &&
      (isTrackSelfOrDescendant(state, trackId, t.id) || isTrackSelfOrDescendant(state, t.id, trackId))
  )
}

/** True when the track actually sounds: its own fader AND every ancestor bus is open. */
export function isTrackEffectivelyAudible(state: ProjectState, trackId: TrackId): boolean {
  let current: TrackId | null = trackId
  const seen = new Set<TrackId>()
  while (current !== null && !seen.has(current)) {
    if (!isTrackAudible(state, current)) return false
    seen.add(current)
    current = state.tracks[current]?.parentId ?? null
  }
  return true
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

/** Direct child tracks of a folder (or roots for null), in trackOrder order. */
export function childTracksOf(state: ProjectState, parentId: TrackId | null): Track[] {
  const out: Track[] = []
  for (const id of state.trackOrder) {
    const track = state.tracks[id]
    if (track && track.parentId === parentId) out.push(track)
  }
  return out
}

/** True if `trackId` is `ancestorId` or lies anywhere under it. */
export function isTrackSelfOrDescendant(
  state: ProjectState,
  trackId: TrackId,
  ancestorId: TrackId
): boolean {
  let current: TrackId | null = trackId
  const seen = new Set<TrackId>() // tolerate corrupt cycles
  while (current !== null && !seen.has(current)) {
    if (current === ancestorId) return true
    seen.add(current)
    current = state.tracks[current]?.parentId ?? null
  }
  return false
}

/** The track and every track under it, in trackOrder order (root first). */
export function trackSubtreeOf(state: ProjectState, trackId: TrackId): Track[] {
  const root = state.tracks[trackId]
  if (!root) return []
  return state.trackOrder
    .map((id) => state.tracks[id])
    .filter((t): t is Track => t !== undefined && isTrackSelfOrDescendant(state, t.id, trackId))
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
