import type { TimeSignature } from './timebase'
import type { PluginDescriptor } from '../plugins/descriptor'
import { DEFAULT_PROJECT_SETTINGS, type ProjectSettings } from './projectSettings'

export type TrackId = string
export type ClipId = string
export type FileNodeId = string
/**
 * 'folder' tracks are grouping buses: no clips, children route through them.
 * 'midi' and 'drum' are both NOTE tracks — same clips, same notes, same
 * instrument slot — separated because a kit is played, edited and mixed
 * differently from a melodic part: a drum track opens on the step grid,
 * defaults to the drum instrument, and reads as its own thing in the
 * arrangement. Nothing stops a drum track from being played by a MIDI
 * keyboard or an electronic kit; the kind describes the MATERIAL, not the
 * controller. Use `isNoteTrackKind` for note logic rather than testing
 * for 'midi', or drum tracks silently lose notes.
 */
export type TrackKind = 'audio' | 'midi' | 'drum' | 'folder'

/** Track kinds that hold MIDI notes and drive an instrument. */
export function isNoteTrackKind(kind: TrackKind): boolean {
  return kind === 'midi' || kind === 'drum'
}

/** Names and header badges for the track kinds — one source for every menu. */
export const TRACK_KIND_LABELS: Readonly<Record<TrackKind, string>> = {
  audio: 'Audio',
  midi: 'MIDI',
  drum: 'Drum',
  folder: 'Folder'
}

export const TRACK_KIND_BADGES: Readonly<Record<TrackKind, string>> = {
  audio: 'A',
  midi: 'M',
  drum: 'D',
  folder: 'F'
}

/** The kinds a user can create, in the order the menus offer them. */
export const CREATABLE_TRACK_KINDS: readonly TrackKind[] = ['audio', 'midi', 'drum', 'folder']
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
   * Audio asset this clip plays, or null (a note clip). Asset binary data
   * is a separate system from project state (see ARCHITECTURE.md); the
   * document only ever references assets by id.
   */
  readonly assetId: string | null
  /**
   * A PATTERN: this clip is bank material, not something on the timeline.
   * It lives in the step panel — the drum loops A, B, C — and never plays
   * at a position of its own; only STAMPS of it do (see `sourceClipId`).
   *
   * The dependency runs one way: clips on the track depend on the pattern,
   * never the reverse. Deleting a stamp therefore leaves the pattern in the
   * bank, ready to stamp again — which is the whole reason a pattern is a
   * separate thing from the clips that place it.
   *
   * `start` is meaningless on one (it is nowhere); `duration` is the
   * pattern's LENGTH. Optional so every pre-existing clip stays exactly
   * what it was: an ordinary clip on the timeline.
   */
  readonly isPattern?: boolean
  /**
   * A STAMP: this clip plays another clip's notes instead of owning any.
   * Stamping a drum loop along the track makes copies that all follow the
   * original — edit the source and every stamp changes with it, which is
   * the whole point of stamping a loop rather than duplicating it.
   *
   * The notes themselves never move: `notesOfClip` is the one accessor and
   * it resolves this, so nothing else in the app has to know. A stamp
   * whose source has gone plays nothing, exactly as a clip whose asset has
   * not arrived plays nothing — no special repair, and undo brings the
   * source back.
   *
   * Optional so audio clips and every pre-existing document need no
   * migration (absent = the clip owns its own notes).
   */
  readonly sourceClipId?: ClipId | null
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
  /**
   * Formant-preserving playback (audio clips): stretch re-times WITHOUT
   * transposing and pitch transposes WITHOUT re-timing, via a
   * phase-vocoder-stretched copy of the source (see clipWarpFactor).
   * Absent/false = the original tape-style resample. Optional so every
   * pre-warp document loads unchanged.
   */
  readonly warp?: boolean
  /**
   * TAKE GROUP: clips on the SAME track sharing a `takeGroupId` are
   * alternative takes of one region — recorded passes over the same bars,
   * of which one is meant to sound (`takeActive`). The INTENT is exactly
   * one active take per group; the reducer deliberately tolerates
   * divergence (concurrent edits may briefly leave zero or several
   * active) and playback resolves it deterministically: a group member
   * plays iff `takeActive` is true, so several claimed actives all play
   * until the next `take/activate` converges the group, and none silences
   * it. Optional so every pre-existing document needs no migration
   * (absent = not a take; null is tolerated as absent). Canonical form:
   * `takeGroupId` present only as a non-empty string, `takeActive`
   * present only when true — so ungrouping round-trips to a clip
   * identical to one that was never grouped.
   */
  readonly takeGroupId?: string | null
  /** The take of its group that actually sounds. See takeGroupId. */
  readonly takeActive?: boolean
  /**
   * This clip's length is NOT bound to measures — a drum solo or fill,
   * which runs for as long as the playing needs rather than a quarter,
   * half or whole measure like the lettered loops. Programming a step past
   * its end extends it exactly to that step instead of rounding up to the
   * next bar.
   *
   * Optional so pre-existing documents need no migration (absent = a
   * measure-shaped loop), following `samplerAssetId`. It is the author's
   * INTENT, not a derived fact — a solo that happens to land on a bar line
   * is still a solo — so it is document state: it saves with the project
   * and reaches collaborators, who would otherwise see it start rounding
   * to bars on their machine.
   */
  readonly freeLength?: boolean
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

/**
 * WARP mode (clip.warp): the clip plays a phase-vocoder-stretched copy of
 * its source instead of resampling it, so stretch does not transpose and
 * pitch does not re-time. The pre-stretched buffer's factor is
 * stretch · 2^(pitch/12); playing it at rate 2^(pitch/12) then yields a
 * timeline length of source · stretch (stretch alone re-times) and a
 * transposition of exactly `pitch` (pitch alone transposes). Tape mode
 * (warp off) keeps clipRate's coupled behavior. Both helpers are pure so
 * scheduling, rendering, caching and the UI agree exactly.
 */
export function clipWarpFactor(clip: Clip): number {
  if (!clip.warp) return 1
  const stretch = clip.stretch > 0 ? clip.stretch : 1
  return stretch * Math.pow(2, clip.pitch / 12)
}

/** The resampling rate actually applied at playback (see clipWarpFactor). */
export function clipPlaybackRate(clip: Clip): number {
  return clip.warp ? Math.pow(2, clip.pitch / 12) : clipRate(clip)
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
  /**
   * The asset the track's SAMPLER instrument plays (see the smp* params
   * in SYNTH_DEFS). Optional so pre-sampler documents and fixtures need
   * no migration; absent = null = no sample loaded (the sampler is
   * silent). Set via `track/setSampler`; counted as a document asset
   * reference (save GC, memory, collab transfer) like frozenAssetId.
   */
  readonly samplerAssetId?: string | null
  /**
   * Graph-editor positions of the In / Mix Out terminal nodes (absent =
   * automatic layout). Document data like PluginInstance.graphX, so a
   * plugin tree keeps its arrangement for every collaborator.
   */
  readonly graphInX?: number
  readonly graphInY?: number
  readonly graphOutX?: number
  readonly graphOutY?: number
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
  /**
   * Node position in the track's routing graph (document data, like clip
   * colors — the layout is shared). Absent = auto-layout by graph depth.
   */
  readonly graphX?: number
  readonly graphY?: number
}

export type RouteId = string

/**
 * One audio connection in a track's effect ROUTING GRAPH. The endpoints
 * are plugin instances of the same track, or the track's fixed terminals:
 * 'in' (the track source — clips/synth) and 'out' (the mix/output node,
 * pre-automation/fader; multiple arrivals sum there, fan-out is free).
 *
 * A track with NO routes uses the classic linear chain (rank order) — the
 * graph exists only once the user materializes it, and deleting every
 * route returns the track to chain routing.
 */
export interface Route {
  readonly id: RouteId
  readonly trackId: TrackId
  readonly from: 'in' | PluginInstanceId
  readonly to: 'out' | PluginInstanceId
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
 *
 * With `instanceId` set the point automates an INSERT EFFECT's parameter
 * instead: `param` names one of the plugin's params and `value` maps
 * linearly onto that param's min..max range. While points exist for a
 * param, they own it (the knob is overridden during playback).
 */
export interface AutomationPoint {
  readonly id: AutomationPointId
  readonly trackId: TrackId
  /** 'volume' | 'pan' for the track; a plugin param name when instanceId is set. */
  readonly param: string
  /** The insert this point automates; absent = track volume/pan. */
  readonly instanceId?: PluginInstanceId
  readonly ticks: number
  readonly value: number
}

export type PadId = string
export type PadKind = 'sample' | 'note' | 'clip'

/** Performance-pad grid dimensions (a classic 8×8 launchpad). */
export const PAD_GRID_ROWS = 8
export const PAD_GRID_COLS = 8

/**
 * A pad's id IS its grid cell, so two peers assigning the same cell
 * concurrently write the same entity and converge by last-write-wins —
 * exactly the right outcome for "we both grabbed pad 3".
 */
export function padIdAt(row: number, col: number): PadId {
  return `pad-r${row}c${col}`
}

/**
 * One cell of the performance-pad grid (the launchpad surface). The
 * ASSIGNMENT is document state — shared, undoable, synced — because a
 * collaborative DJ set needs everyone looking at the same bank. TRIGGERING
 * a pad is a performance, not an edit: it never touches the document (it
 * rides the presence channel so peers can hear it, like live cursors are
 * seen). Pads reference clips/tracks/assets by id and tolerate the target
 * vanishing — a stale pad simply makes no sound, mirroring how bay entries
 * survive asset deletion.
 */
export interface PerformancePad {
  readonly id: PadId
  readonly row: number
  readonly col: number
  readonly kind: PadKind
  /** 'sample' pads: the one-shot/gated asset to fire. */
  readonly assetId: string | null
  /** 'note' pads: play this track's instrument… */
  readonly trackId: TrackId | null
  /** …at this pitch. */
  readonly pitch: number
  /** 'clip' pads: loop this clip, quantized to the next bar. */
  readonly clipId: ClipId | null
  readonly name: string
  /** null = the default pad tint (or the target clip's color). */
  readonly color: string | null
  /** sample/note pads: stop on release (gate) instead of one-shot. */
  readonly gate: boolean
}

/**
 * Field-by-field pad hygiene, shared by the reducer and the file loader
 * (routes-grade validation: a doctored .sdaw or a hostile peer cannot
 * smuggle malformed pads past either door). Null = unusable. The id must
 * be the cell's canonical id — pad identity IS the grid cell — and fields
 * irrelevant to the pad's kind are nulled so equality stays meaningful.
 */
export function sanitizePad(raw: PerformancePad): PerformancePad | null {
  if (typeof raw !== 'object' || raw === null) return null
  const row = Math.round(raw.row)
  const col = Math.round(raw.col)
  if (!Number.isInteger(row) || row < 0 || row >= PAD_GRID_ROWS) return null
  if (!Number.isInteger(col) || col < 0 || col >= PAD_GRID_COLS) return null
  if (raw.id !== padIdAt(row, col)) return null
  if (raw.kind !== 'sample' && raw.kind !== 'note' && raw.kind !== 'clip') return null
  const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null)
  const pitch = Number.isFinite(raw.pitch) ? Math.min(127, Math.max(0, Math.round(raw.pitch))) : 60
  return {
    id: raw.id,
    row,
    col,
    kind: raw.kind,
    assetId: raw.kind === 'sample' ? str(raw.assetId) : null,
    trackId: raw.kind === 'note' ? str(raw.trackId) : null,
    pitch: raw.kind === 'note' ? pitch : 60,
    clipId: raw.kind === 'clip' ? str(raw.clipId) : null,
    name: typeof raw.name === 'string' ? raw.name : '',
    color: str(raw.color),
    gate: raw.gate === true
  }
}

export function padsEqual(a: PerformancePad, b: PerformancePad): boolean {
  return (
    a.id === b.id &&
    a.row === b.row &&
    a.col === b.col &&
    a.kind === b.kind &&
    a.assetId === b.assetId &&
    a.trackId === b.trackId &&
    a.pitch === b.pitch &&
    a.clipId === b.clipId &&
    a.name === b.name &&
    a.color === b.color &&
    a.gate === b.gate
  )
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
  /** Song lyrics — one shared text, saved with the project. */
  readonly lyrics: string
  readonly comments: Readonly<Record<CommentId, Comment>>
  readonly masterVolume: number
  readonly automation: Readonly<Record<AutomationPointId, AutomationPoint>>
  readonly notes: Readonly<Record<NoteId, Note>>
  readonly plugins: Readonly<Record<PluginInstanceId, PluginInstance>>
  readonly routes: Readonly<Record<RouteId, Route>>
  /** The performance-pad grid (see PerformancePad). Keyed by cell id. */
  readonly pads: Readonly<Record<PadId, PerformancePad>>
  /** Shared project-scoped settings (loudness target, defaults). See projectSettings.ts. */
  readonly settings: ProjectSettings
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
    lyrics: '',
    comments: {},
    masterVolume: 1,
    automation: {},
    notes: {},
    plugins: {},
    routes: {},
    pads: {},
    settings: DEFAULT_PROJECT_SETTINGS
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

/** True when the track exists and holds notes (a MIDI or drum track). */
export function isNoteTrack(state: ProjectState, trackId: TrackId): boolean {
  const track = state.tracks[trackId]
  return track !== undefined && isNoteTrackKind(track.kind)
}

/** A track's insert chain in processing order. */
export function pluginsOfTrack(state: ProjectState, trackId: TrackId): PluginInstance[] {
  return Object.values(state.plugins)
    .filter((p) => p.trackId === trackId)
    .sort((a, b) => a.rank - b.rank)
}

/** A track's routing-graph edges (empty = classic linear chain applies). */
export function routesOfTrack(state: ProjectState, trackId: TrackId): Route[] {
  return Object.values(state.routes).filter((r) => r.trackId === trackId)
}

/**
 * Which clip actually OWNS the notes a clip plays: itself, or the loop it
 * was stamped from. One hop only — a stamp of a stamp resolves to the same
 * source, so this can never cycle however the document was assembled.
 */
export function noteSourceOf(state: ProjectState, clipId: ClipId): ClipId {
  const source = state.clips[clipId]?.sourceClipId
  return source && state.clips[source] ? source : clipId
}

/**
 * The notes a clip sounds. Starts stay clip-relative, so a stamp plays the
 * source's notes at its own position — and an edit to the source is heard
 * in every stamp of it, because there is only ever one set of notes.
 */
export function notesOfClip(state: ProjectState, clipId: ClipId): Note[] {
  const ownerId = noteSourceOf(state, clipId)
  return Object.values(state.notes)
    .filter((n) => n.clipId === ownerId)
    .sort((a, b) => a.start - b.start || a.pitch - b.pitch)
}

/** Every clip stamped from this one (not including itself). */
export function stampsOf(state: ProjectState, clipId: ClipId): Clip[] {
  return Object.values(state.clips)
    .filter((c) => c.sourceClipId === clipId)
    .sort((a, b) => a.start - b.start)
}

/**
 * The clips that are actually ON the timeline. Patterns are bank material
 * and live nowhere, so everything that draws, schedules or measures the
 * arrangement asks for these rather than every clip in the document.
 */
export function timelineClips(state: ProjectState): Clip[] {
  return Object.values(state.clips).filter((c) => !c.isPattern)
}

/**
 * Whether take state lets this clip SOUND: not a take-group member, or the
 * member marked active. Deliberately per-clip (no group scan): if
 * concurrent edits leave several members claiming active, all of them play
 * until the next take/activate converges the group — simple, convergent,
 * and never silent by accident. Shared by the schedulers, song-end math
 * and the UI so they can never disagree.
 */
export function isClipTakeAudible(clip: Clip): boolean {
  return !clip.takeGroupId || clip.takeActive === true
}

/**
 * The members of a take group, in a deterministic order (start, then id) —
 * the order the take badges ("T2/3") and expanded take lanes present, so
 * every collaborator numbers the takes identically.
 */
export function takeGroupMembers(state: ProjectState, groupId: string): Clip[] {
  return Object.values(state.clips)
    .filter((c) => c.takeGroupId === groupId)
    .sort((a, b) => a.start - b.start || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

/**
 * A track's take groups, each with its members in badge order. The lane
 * count of an expanded track is the largest group's size.
 */
export function takeGroupsOfTrack(state: ProjectState, trackId: TrackId): Map<string, Clip[]> {
  const groups = new Map<string, Clip[]>()
  for (const clip of Object.values(state.clips)) {
    if (clip.trackId !== trackId || !clip.takeGroupId) continue
    const list = groups.get(clip.takeGroupId)
    if (list) list.push(clip)
    else groups.set(clip.takeGroupId, [clip])
  }
  for (const list of groups.values()) {
    list.sort((a, b) => a.start - b.start || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  }
  return groups
}

/**
 * A track's bank: the material it can play, which is every note clip that
 * OWNS its notes. That covers both kinds — patterns, which live only in
 * the bank, and ordinary note clips, which also sit on the timeline (every
 * clip predating patterns is one of these, so old projects keep working
 * and can be stamped like anything else). Stamps are excluded: they are
 * the same material somewhere else, and a bank reading "A, A, A" would
 * list positions rather than material.
 */
export function patternsOfTrack(state: ProjectState, trackId: TrackId): Clip[] {
  return Object.values(state.clips)
    .filter((c) => c.trackId === trackId && c.assetId === null && !c.sourceClipId)
    .sort((a, b) =>
      a.isPattern === b.isPattern
        ? a.name < b.name
          ? -1
          : a.name > b.name
            ? 1
            : a.id < b.id
              ? -1
              : 1
        : a.isPattern
          ? -1
          : 1
    )
}

/**
 * A track's points for one parameter, in timeline order. `instanceId`
 * selects an insert's param curve; absent = the track's own volume/pan
 * (plugin points never leak into track lanes and vice versa).
 */
export function automationOf(
  state: ProjectState,
  trackId: TrackId,
  param: string,
  instanceId?: PluginInstanceId
): AutomationPoint[] {
  return Object.values(state.automation)
    .filter((p) => p.trackId === trackId && p.param === param && p.instanceId === instanceId)
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
