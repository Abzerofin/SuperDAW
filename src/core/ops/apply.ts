import type {
  ProjectState,
  Track,
  Clip,
  TrackId,
  ClipId,
  Comment,
  FileNode,
  AutomationPoint,
  Note
} from '../model/types'
import { clipsOfTrack, isSelfOrDescendant, subtreeOf, MAX_GAIN } from '../model/types'

/** Insert notes, skipping ids that exist and notes whose clip is missing. */
function withNotes(
  notes: Readonly<Record<string, Note>>,
  clips: Readonly<Record<string, Clip>>,
  incoming: readonly Note[]
): { notes: Record<string, Note>; changed: boolean } {
  const next = { ...notes }
  let changed = false
  for (const note of incoming) {
    if (next[note.id] || !clips[note.clipId]) continue
    next[note.id] = {
      ...note,
      pitch: clampInt(note.pitch, 0, 127),
      start: Math.max(0, note.start),
      duration: Math.max(1, note.duration),
      velocity: clampInt(note.velocity, 1, 127)
    }
    changed = true
  }
  return { notes: next, changed }
}

function clampInt(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)))
}
import type { Operation } from './operations'

/**
 * Pure reducer: (state, operation) -> state. Never mutates.
 *
 * Operations targeting entities that no longer exist return the state
 * unchanged rather than throwing. In a collaborative session a peer can
 * legitimately send an op for a clip another peer just deleted; dropping
 * the op keeps every peer convergent.
 */
export function apply(state: ProjectState, op: Operation): ProjectState {
  switch (op.type) {
    case 'project/rename':
      if (state.name === op.name) return state
      return { ...state, name: op.name }

    case 'project/setTempo': {
      const tempo = clamp(op.tempo, 20, 400)
      if (state.tempo === tempo) return state
      return { ...state, tempo }
    }

    case 'track/create': {
      if (state.tracks[op.track.id]) return state
      const trackOrder = [...state.trackOrder]
      trackOrder.splice(clamp(op.index, 0, trackOrder.length), 0, op.track.id)
      const clips = { ...state.clips }
      for (const clip of op.clips) clips[clip.id] = clip
      const automation = { ...state.automation }
      for (const point of op.automation) automation[point.id] = point
      const { notes } = withNotes(state.notes, clips, op.notes)
      return {
        ...state,
        tracks: { ...state.tracks, [op.track.id]: op.track },
        trackOrder,
        clips,
        automation,
        notes
      }
    }

    case 'track/delete': {
      if (!state.tracks[op.trackId]) return state
      const tracks = { ...state.tracks }
      delete tracks[op.trackId]
      const clips: Record<ClipId, Clip> = {}
      for (const clip of Object.values(state.clips)) {
        if (clip.trackId !== op.trackId) clips[clip.id] = clip
      }
      const automation: Record<string, AutomationPoint> = {}
      for (const point of Object.values(state.automation)) {
        if (point.trackId !== op.trackId) automation[point.id] = point
      }
      const notes: Record<string, Note> = {}
      for (const note of Object.values(state.notes)) {
        if (clips[note.clipId]) notes[note.id] = note
      }
      return {
        ...state,
        tracks,
        trackOrder: state.trackOrder.filter((id) => id !== op.trackId),
        clips,
        automation,
        notes
      }
    }

    case 'track/setVolume':
      return updateTrack(state, op.trackId, (t) => ({
        ...t,
        volume: clamp(op.volume, 0, MAX_GAIN)
      }))

    case 'track/setPan':
      return updateTrack(state, op.trackId, (t) => ({ ...t, pan: clamp(op.pan, -1, 1) }))

    case 'project/setMasterVolume': {
      const volume = clamp(op.volume, 0, MAX_GAIN)
      if (state.masterVolume === volume) return state
      return { ...state, masterVolume: volume }
    }

    case 'automation/add': {
      if (state.automation[op.point.id]) return state
      if (!state.tracks[op.point.trackId]) return state
      const point = {
        ...op.point,
        ticks: Math.max(0, op.point.ticks),
        value: clamp(op.point.value, 0, 1)
      }
      return { ...state, automation: { ...state.automation, [point.id]: point } }
    }

    case 'automation/move': {
      const point = state.automation[op.pointId]
      if (!point) return state
      const ticks = Math.max(0, op.ticks)
      const value = clamp(op.value, 0, 1)
      if (point.ticks === ticks && point.value === value) return state
      return {
        ...state,
        automation: { ...state.automation, [op.pointId]: { ...point, ticks, value } }
      }
    }

    case 'automation/delete': {
      if (!state.automation[op.pointId]) return state
      const automation = { ...state.automation }
      delete automation[op.pointId]
      return { ...state, automation }
    }

    case 'note/add': {
      const { notes, changed } = withNotes(state.notes, state.clips, [op.note])
      return changed ? { ...state, notes } : state
    }

    case 'note/addMany': {
      const { notes, changed } = withNotes(state.notes, state.clips, op.notes)
      return changed ? { ...state, notes } : state
    }

    case 'note/move': {
      const note = state.notes[op.noteId]
      if (!note) return state
      const pitch = clampInt(op.pitch, 0, 127)
      const start = Math.max(0, op.start)
      if (note.pitch === pitch && note.start === start) return state
      return { ...state, notes: { ...state.notes, [op.noteId]: { ...note, pitch, start } } }
    }

    case 'note/resize': {
      const note = state.notes[op.noteId]
      if (!note) return state
      const duration = Math.max(1, op.duration)
      if (note.duration === duration) return state
      return { ...state, notes: { ...state.notes, [op.noteId]: { ...note, duration } } }
    }

    case 'note/delete': {
      const doomed = new Set(op.noteIds)
      let changed = false
      const notes: Record<string, Note> = {}
      for (const note of Object.values(state.notes)) {
        if (doomed.has(note.id)) changed = true
        else notes[note.id] = note
      }
      return changed ? { ...state, notes } : state
    }

    case 'track/rename':
      return updateTrack(state, op.trackId, (t) => ({ ...t, name: op.name }))

    case 'track/setMute':
      return updateTrack(state, op.trackId, (t) => ({ ...t, muted: op.muted }))

    case 'track/setSolo':
      return updateTrack(state, op.trackId, (t) => ({ ...t, soloed: op.soloed }))

    case 'track/reorder': {
      const from = state.trackOrder.indexOf(op.trackId)
      if (from === -1) return state
      const trackOrder = [...state.trackOrder]
      trackOrder.splice(from, 1)
      trackOrder.splice(clamp(op.index, 0, trackOrder.length), 0, op.trackId)
      return { ...state, trackOrder }
    }

    case 'clip/create': {
      if (state.clips[op.clip.id]) return state
      if (!state.tracks[op.clip.trackId]) return state
      const clips = { ...state.clips, [op.clip.id]: op.clip }
      const { notes } = withNotes(state.notes, clips, op.notes)
      return { ...state, clips, notes }
    }

    case 'clip/delete': {
      if (!state.clips[op.clipId]) return state
      const clips = { ...state.clips }
      delete clips[op.clipId]
      const notes: Record<string, Note> = {}
      for (const note of Object.values(state.notes)) {
        if (note.clipId !== op.clipId) notes[note.id] = note
      }
      return { ...state, clips, notes }
    }

    case 'clip/move': {
      if (!state.tracks[op.trackId]) return state
      return updateClip(state, op.clipId, (c) => ({
        ...c,
        trackId: op.trackId,
        start: Math.max(0, op.start)
      }))
    }

    case 'clip/resize':
      return updateClip(state, op.clipId, (c) => ({
        ...c,
        start: Math.max(0, op.start),
        duration: Math.max(1, op.duration),
        offset: Math.max(0, op.offset)
      }))

    case 'clip/rename':
      return updateClip(state, op.clipId, (c) => ({ ...c, name: op.name }))

    case 'file/create': {
      const files = { ...state.files }
      let changed = false
      for (const node of op.nodes) {
        if (files[node.id]) continue
        // A node's parent must exist (or be root) and be a folder.
        if (node.parentId !== null) {
          const parent = files[node.parentId]
          if (!parent || parent.kind !== 'folder') continue
        }
        files[node.id] = node
        changed = true
      }
      return changed ? { ...state, files } : state
    }

    case 'file/delete': {
      const doomed = new Set<string>()
      for (const nodeId of op.nodeIds) {
        for (const node of subtreeOf(state, nodeId)) doomed.add(node.id)
      }
      if (doomed.size === 0) return state
      const files: Record<string, FileNode> = {}
      for (const node of Object.values(state.files)) {
        if (!doomed.has(node.id)) files[node.id] = node
      }
      return { ...state, files }
    }

    case 'file/rename': {
      const node = state.files[op.nodeId]
      if (!node || node.name === op.name) return state
      return { ...state, files: { ...state.files, [op.nodeId]: { ...node, name: op.name } } }
    }

    case 'chat/post': {
      if (state.chat.some((m) => m.id === op.message.id)) return state
      return { ...state, chat: [...state.chat, op.message] }
    }

    case 'comment/add': {
      const comments = { ...state.comments }
      let changed = false
      for (const comment of op.comments) {
        if (comments[comment.id]) continue
        // A reply's root must exist (deleted-thread replies are dropped).
        if (comment.parentId !== null && !comments[comment.parentId]) continue
        comments[comment.id] = comment
        changed = true
      }
      return changed ? { ...state, comments } : state
    }

    case 'comment/delete': {
      const target = state.comments[op.commentId]
      if (!target) return state
      const comments: Record<string, Comment> = {}
      for (const comment of Object.values(state.comments)) {
        if (comment.id === op.commentId || comment.parentId === op.commentId) continue
        comments[comment.id] = comment
      }
      return { ...state, comments }
    }

    case 'comment/setResolved': {
      const comment = state.comments[op.commentId]
      if (!comment || comment.resolved === op.resolved) return state
      return {
        ...state,
        comments: { ...state.comments, [op.commentId]: { ...comment, resolved: op.resolved } }
      }
    }

    case 'file/move': {
      const node = state.files[op.nodeId]
      if (!node || node.parentId === op.parentId) return state
      if (op.parentId !== null) {
        const target = state.files[op.parentId]
        if (!target || target.kind !== 'folder') return state
        // A folder can never be moved into itself or its own subtree.
        if (isSelfOrDescendant(state, op.parentId, op.nodeId)) return state
      }
      return {
        ...state,
        files: { ...state.files, [op.nodeId]: { ...node, parentId: op.parentId } }
      }
    }
  }
}

function updateTrack(
  state: ProjectState,
  trackId: TrackId,
  fn: (track: Track) => Track
): ProjectState {
  const track = state.tracks[trackId]
  if (!track) return state
  const next = fn(track)
  if (next === track) return state
  return { ...state, tracks: { ...state.tracks, [trackId]: next } }
}

function updateClip(
  state: ProjectState,
  clipId: ClipId,
  fn: (clip: Clip) => Clip
): ProjectState {
  const clip = state.clips[clipId]
  if (!clip) return state
  const next = fn(clip)
  if (next === clip) return state
  return { ...state, clips: { ...state.clips, [clipId]: next } }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

export { clipsOfTrack }
