import type { ProjectState, Track, Clip, TrackId, ClipId } from '../model/types'
import { clipsOfTrack } from '../model/types'
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
      return {
        ...state,
        tracks: { ...state.tracks, [op.track.id]: op.track },
        trackOrder,
        clips
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
      return {
        ...state,
        tracks,
        trackOrder: state.trackOrder.filter((id) => id !== op.trackId),
        clips
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
      return { ...state, trackOrder }
    }

    case 'clip/create': {
      if (state.clips[op.clip.id]) return state
      if (!state.tracks[op.clip.trackId]) return state
      return { ...state, clips: { ...state.clips, [op.clip.id]: op.clip } }
    }

    case 'clip/delete': {
      if (!state.clips[op.clipId]) return state
      const clips = { ...state.clips }
      delete clips[op.clipId]
      return { ...state, clips }
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
        duration: Math.max(1, op.duration)
      }))

    case 'clip/rename':
      return updateClip(state, op.clipId, (c) => ({ ...c, name: op.name }))
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
