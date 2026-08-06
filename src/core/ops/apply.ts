import type {
  ProjectState,
  Track,
  Clip,
  TrackId,
  ClipId,
  Comment,
  FileNode,
  AutomationPoint,
  Note,
  PluginInstance
} from '../model/types'
import {
  clipsOfTrack,
  isSelfOrDescendant,
  isTrackSelfOrDescendant,
  subtreeOf,
  MAX_GAIN,
  MAX_PITCH,
  MAX_STRETCH,
  MIN_PITCH,
  MIN_STRETCH,
  isClipLooped,
  normalizeLoop
} from '../model/types'
import { SYNTH_DEFS, clampParam, type ParamDef } from '../model/effects'
import { paramDefsOf } from '../plugins/builtin'

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


/**
 * With param defs (builtins, or external plugins that snapshotted defs):
 * exactly the defined params, each clamped. Without defs the params pass
 * through with only a finite-number guard — clamping must depend solely on
 * document data so every peer sanitizes identically.
 */
function sanitizeParams(
  defs: Readonly<Record<string, ParamDef>> | null,
  incoming: Readonly<Record<string, number>>
): Record<string, number> {
  const params: Record<string, number> = {}
  if (defs) {
    for (const [key, def] of Object.entries(defs)) {
      params[key] = clampParam(def, incoming[key] ?? def.default)
    }
    return params
  }
  for (const [key, value] of Object.entries(incoming)) {
    if (Number.isFinite(value)) params[key] = value
  }
  return params
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

    case 'project/setTimeSignature': {
      const beats = clampInt(op.timeSignature[0], 1, 32)
      const unit = op.timeSignature[1]
      if (![1, 2, 4, 8, 16, 32].includes(unit)) return state
      if (state.timeSignature[0] === beats && state.timeSignature[1] === unit) return state
      return { ...state, timeSignature: [beats, unit] as const }
    }

    case 'track/create': {
      if (state.tracks[op.track.id]) return state
      // Root first, then descendants in ascending original index — exactly
      // reverses a cascading delete. Indices land correctly because every
      // earlier insertion sits at a lower index.
      const inserts = [
        { track: op.track, index: op.index },
        ...(op.descendants ?? []).filter((d) => !state.tracks[d.track.id])
      ].sort((a, b) => a.index - b.index)
      const trackOrder = [...state.trackOrder]
      const tracks = { ...state.tracks }
      for (const { track, index } of inserts) {
        trackOrder.splice(clamp(index, 0, trackOrder.length), 0, track.id)
        tracks[track.id] = track
      }
      // A parent that doesn't exist (concurrent folder delete) degrades to root.
      for (const { track } of inserts) {
        if (track.parentId !== null && !tracks[track.parentId]) {
          tracks[track.id] = { ...track, parentId: null }
        }
      }
      const clips = { ...state.clips }
      for (const clip of op.clips) {
        if (tracks[clip.trackId]) clips[clip.id] = clip
      }
      const automation = { ...state.automation }
      for (const point of op.automation) automation[point.id] = point
      const { notes } = withNotes(state.notes, clips, op.notes)
      const plugins = { ...state.plugins }
      for (const instance of op.plugins) {
        if (!plugins[instance.id]) plugins[instance.id] = instance
      }
      return { ...state, tracks, trackOrder, clips, automation, notes, plugins }
    }

    case 'track/delete': {
      if (!state.tracks[op.trackId]) return state
      // Folders cascade: deleting a folder removes its whole subtree.
      const doomed = new Set(
        state.trackOrder.filter((id) => isTrackSelfOrDescendant(state, id, op.trackId))
      )
      const tracks: Record<TrackId, Track> = {}
      for (const track of Object.values(state.tracks)) {
        if (!doomed.has(track.id)) tracks[track.id] = track
      }
      const clips: Record<ClipId, Clip> = {}
      for (const clip of Object.values(state.clips)) {
        if (!doomed.has(clip.trackId)) clips[clip.id] = clip
      }
      const automation: Record<string, AutomationPoint> = {}
      for (const point of Object.values(state.automation)) {
        if (!doomed.has(point.trackId)) automation[point.id] = point
      }
      const notes: Record<string, Note> = {}
      for (const note of Object.values(state.notes)) {
        if (clips[note.clipId]) notes[note.id] = note
      }
      const plugins: Record<string, PluginInstance> = {}
      for (const instance of Object.values(state.plugins)) {
        if (!doomed.has(instance.trackId)) plugins[instance.id] = instance
      }
      return {
        ...state,
        tracks,
        trackOrder: state.trackOrder.filter((id) => !doomed.has(id)),
        clips,
        automation,
        notes,
        plugins
      }
    }

    case 'track/setParent': {
      const track = state.tracks[op.trackId]
      if (!track || track.parentId === op.parentId) return state
      if (op.parentId !== null) {
        const parent = state.tracks[op.parentId]
        if (!parent || parent.kind !== 'folder') return state
        // A folder can never be moved into itself or its own subtree.
        if (isTrackSelfOrDescendant(state, op.parentId, op.trackId)) return state
      }
      return {
        ...state,
        tracks: { ...state.tracks, [op.trackId]: { ...track, parentId: op.parentId } }
      }
    }

    case 'track/freeze': {
      const track = state.tracks[op.trackId]
      if (!track || track.kind === 'folder' || track.frozenAssetId === op.assetId) return state
      return {
        ...state,
        tracks: { ...state.tracks, [op.trackId]: { ...track, frozenAssetId: op.assetId } }
      }
    }

    case 'track/unfreeze': {
      const track = state.tracks[op.trackId]
      if (!track || track.frozenAssetId === null) return state
      return {
        ...state,
        tracks: { ...state.tracks, [op.trackId]: { ...track, frozenAssetId: null } }
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

    case 'note/setVelocity': {
      const note = state.notes[op.noteId]
      if (!note) return state
      const velocity = clampInt(op.velocity, 1, 127)
      if (note.velocity === velocity) return state
      return { ...state, notes: { ...state.notes, [op.noteId]: { ...note, velocity } } }
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

    case 'plugin/add': {
      if (state.plugins[op.instance.id]) return state
      if (!state.tracks[op.instance.trackId]) return state
      const defs = paramDefsOf(op.instance.descriptor)
      // A builtin descriptor whose uid core doesn't know is unusable.
      if (op.instance.descriptor.format === 'builtin' && !defs) return state
      const params = sanitizeParams(defs, op.instance.params)
      return {
        ...state,
        plugins: { ...state.plugins, [op.instance.id]: { ...op.instance, params } }
      }
    }

    case 'plugin/remove': {
      if (!state.plugins[op.instanceId]) return state
      const plugins = { ...state.plugins }
      delete plugins[op.instanceId]
      return { ...state, plugins }
    }

    case 'plugin/setParam': {
      const instance = state.plugins[op.instanceId]
      if (!instance || !Number.isFinite(op.value)) return state
      const defs = paramDefsOf(instance.descriptor)
      const def = defs?.[op.param]
      if (defs && !def) return state
      const value = def ? clampParam(def, op.value) : op.value
      if (instance.params[op.param] === value) return state
      return {
        ...state,
        plugins: {
          ...state.plugins,
          [op.instanceId]: { ...instance, params: { ...instance.params, [op.param]: value } }
        }
      }
    }

    case 'plugin/setEnabled': {
      const instance = state.plugins[op.instanceId]
      if (!instance || instance.enabled === op.enabled) return state
      return {
        ...state,
        plugins: { ...state.plugins, [op.instanceId]: { ...instance, enabled: op.enabled } }
      }
    }

    case 'track/setSynthParam': {
      const track = state.tracks[op.trackId]
      if (!track || track.kind !== 'midi') return state
      const def = SYNTH_DEFS[op.param]
      if (!def) return state
      const value = clampParam(def, op.value)
      if (track.synth[op.param] === value) return state
      return {
        ...state,
        tracks: {
          ...state.tracks,
          [op.trackId]: { ...track, synth: { ...track.synth, [op.param]: value } }
        }
      }
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
      let next: ProjectState = { ...state, trackOrder }
      // Optional atomic re-parent (drag into/out of a folder = one op).
      if (op.parentId !== undefined) {
        next = apply(next, { type: 'track/setParent', trackId: op.trackId, parentId: op.parentId })
      }
      return next
    }

    case 'clip/create': {
      if (state.clips[op.clip.id]) return state
      const track = state.tracks[op.clip.trackId]
      if (!track || track.kind === 'folder') return state // folders hold tracks, not clips
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
      const target = state.tracks[op.trackId]
      if (!target || target.kind === 'folder') return state
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
        offset: Math.max(0, op.offset),
        loopLength: op.loopLength !== undefined ? normalizeLoop(op.loopLength) : c.loopLength,
        // Same clamp/rounding as clip/setPlayback, so the two ops agree.
        stretch:
          op.stretch !== undefined && Number.isFinite(op.stretch)
            ? Math.min(MAX_STRETCH, Math.max(MIN_STRETCH, Math.round(op.stretch * 1000) / 1000))
            : c.stretch
      }))

    case 'clip/rename':
      return updateClip(state, op.clipId, (c) => ({ ...c, name: op.name }))

    case 'clip/setColor':
      return updateClip(state, op.clipId, (c) =>
        c.color === op.color ? c : { ...c, color: op.color }
      )

    case 'clip/setPlayback':
      return updateClip(state, op.clipId, (c) => {
        const pitch = Number.isFinite(op.pitch)
          ? Math.min(MAX_PITCH, Math.max(MIN_PITCH, Math.round(op.pitch * 100) / 100))
          : c.pitch
        const stretch = Number.isFinite(op.stretch)
          ? Math.min(MAX_STRETCH, Math.max(MIN_STRETCH, Math.round(op.stretch * 1000) / 1000))
          : c.stretch
        return c.reverse === op.reverse && c.pitch === pitch && c.stretch === stretch
          ? c
          : { ...c, reverse: op.reverse, pitch, stretch }
      })

    case 'clip/setFades':
      return updateClip(state, op.clipId, (c) => {
        // Fades can never overlap: cap each at the duration, then shrink
        // the fade-out first if they still collide (deterministic).
        const fadeIn = clampInt(op.fadeIn, 0, c.duration)
        const fadeOut = clampInt(op.fadeOut, 0, c.duration - fadeIn)
        return c.fadeIn === fadeIn && c.fadeOut === fadeOut ? c : { ...c, fadeIn, fadeOut }
      })

    case 'clip/split': {
      const clip = state.clips[op.clipId]
      if (!clip) return state
      if (state.clips[op.rightClipId]) return state // already split (idempotency)
      const at = Math.round(op.at)
      if (at <= clip.start || at >= clip.start + clip.duration) return state
      const splitOffset = at - clip.start
      const leftDuration = clamp(op.leftDuration ?? splitOffset, 1, splitOffset)
      const right: Clip = {
        id: op.rightClipId,
        trackId: clip.trackId,
        name: op.rightName ?? clip.name,
        start: at,
        duration: clip.start + clip.duration - at,
        assetId: clip.assetId,
        // Audio keeps playing the same source material across the cut; in a
        // looped clip the cut may land mid-repeat, so take the offset within
        // the pattern rather than from the clip's start.
        offset:
          clip.assetId !== null
            ? clip.offset + (isClipLooped(clip) ? splitOffset % clip.loopLength : splitOffset)
            : 0,
        color: op.rightColor !== undefined ? op.rightColor : clip.color,
        // The original fade-out travels with the clip's end (the right half).
        fadeIn: op.rightFades ? op.rightFades[0] : 0,
        fadeOut: op.rightFades ? op.rightFades[1] : clip.fadeOut,
        // Both halves keep playing the same way (reversed/transposed/scaled).
        reverse: clip.reverse,
        pitch: clip.pitch,
        stretch: clip.stretch,
        // A looped clip's halves keep the period; the right half starts at
        // its position WITHIN the pattern so audio is continuous at the cut
        // (its later repeats then cycle from that point, not the original
        // phase — the price of not storing a separate loop-phase field).
        loopLength: clip.loopLength
      }
      const clips = {
        ...state.clips,
        [clip.id]: { ...clip, duration: leftDuration, fadeOut: op.leftFadeOut ?? 0 },
        [right.id]: right
      }
      // Notes at/after the cut move to the right clip, re-based to its start.
      let notes = state.notes
      let notesChanged = false
      const nextNotes: Record<string, Note> = { ...state.notes }
      for (const note of Object.values(state.notes)) {
        if (note.clipId !== clip.id || note.start < splitOffset) continue
        nextNotes[note.id] = { ...note, clipId: right.id, start: note.start - splitOffset }
        notesChanged = true
      }
      if (notesChanged) notes = nextNotes
      return { ...state, clips, notes }
    }

    case 'clip/merge': {
      const left = state.clips[op.clipId]
      const right = state.clips[op.rightClipId]
      if (!left || !right || left.trackId !== right.trackId) return state
      if (right.start < left.start) return state
      const duration = Math.max(left.duration, right.start + right.duration - left.start)
      // The merged clip's end is the right clip's end: its fade-out wins.
      const clips = { ...state.clips, [left.id]: { ...left, duration, fadeOut: right.fadeOut } }
      delete clips[right.id]
      const shift = right.start - left.start
      let notes = state.notes
      let notesChanged = false
      const nextNotes: Record<string, Note> = { ...state.notes }
      for (const note of Object.values(state.notes)) {
        if (note.clipId !== right.id) continue
        nextNotes[note.id] = { ...note, clipId: left.id, start: note.start + shift }
        notesChanged = true
      }
      if (notesChanged) notes = nextNotes
      return { ...state, clips, notes }
    }

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
