import type { ProjectState } from '../model/types'
import { clipsOfTrack } from '../model/types'
import type { Operation } from './operations'

/**
 * Derives the inverse of an operation given the state *before* it is applied.
 * Powers undo: applying `invert(state, op)` after `apply(state, op)` returns
 * to the original state. Returns null when the target no longer exists.
 */
export function invert(state: ProjectState, op: Operation): Operation | null {
  switch (op.type) {
    case 'project/rename':
      return { type: 'project/rename', name: state.name }

    case 'project/setTempo':
      return { type: 'project/setTempo', tempo: state.tempo }

    case 'track/create':
      return { type: 'track/delete', trackId: op.track.id }

    case 'track/delete': {
      const track = state.tracks[op.trackId]
      if (!track) return null
      return {
        type: 'track/create',
        track,
        index: state.trackOrder.indexOf(op.trackId),
        clips: clipsOfTrack(state, op.trackId)
      }
    }

    case 'track/rename': {
      const track = state.tracks[op.trackId]
      if (!track) return null
      return { type: 'track/rename', trackId: op.trackId, name: track.name }
    }

    case 'track/setMute': {
      const track = state.tracks[op.trackId]
      if (!track) return null
      return { type: 'track/setMute', trackId: op.trackId, muted: track.muted }
    }

    case 'track/setSolo': {
      const track = state.tracks[op.trackId]
      if (!track) return null
      return { type: 'track/setSolo', trackId: op.trackId, soloed: track.soloed }
    }

    case 'track/reorder': {
      const index = state.trackOrder.indexOf(op.trackId)
      if (index === -1) return null
      return { type: 'track/reorder', trackId: op.trackId, index }
    }

    case 'clip/create':
      return { type: 'clip/delete', clipId: op.clip.id }

    case 'clip/delete': {
      const clip = state.clips[op.clipId]
      if (!clip) return null
      return { type: 'clip/create', clip }
    }

    case 'clip/move': {
      const clip = state.clips[op.clipId]
      if (!clip) return null
      return {
        type: 'clip/move',
        clipId: op.clipId,
        trackId: clip.trackId,
        start: clip.start
      }
    }

    case 'clip/resize': {
      const clip = state.clips[op.clipId]
      if (!clip) return null
      return {
        type: 'clip/resize',
        clipId: op.clipId,
        start: clip.start,
        duration: clip.duration,
        offset: clip.offset
      }
    }

    case 'clip/rename': {
      const clip = state.clips[op.clipId]
      if (!clip) return null
      return { type: 'clip/rename', clipId: op.clipId, name: clip.name }
    }
  }
}
