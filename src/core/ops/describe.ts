import type { ProjectState } from '../model/types'
import type { Operation } from './operations'

/**
 * Human-readable description of an operation, evaluated against the state
 * *before* the op is applied (so deletions can name what they removed).
 * Feeds the activity feed.
 */
export function describe(state: ProjectState, op: Operation): string {
  switch (op.type) {
    case 'project/rename':
      return `Renamed project to "${op.name}"`
    case 'project/setTempo':
      return `Set tempo to ${op.tempo} BPM`
    case 'track/create':
      return `Created ${op.track.kind} track "${op.track.name}"`
    case 'track/delete':
      return `Deleted track "${trackName(state, op.trackId)}"`
    case 'track/rename':
      return `Renamed track "${trackName(state, op.trackId)}" to "${op.name}"`
    case 'track/setMute':
      return `${op.muted ? 'Muted' : 'Unmuted'} "${trackName(state, op.trackId)}"`
    case 'track/setSolo':
      return `${op.soloed ? 'Soloed' : 'Unsoloed'} "${trackName(state, op.trackId)}"`
    case 'track/reorder':
      return `Reordered track "${trackName(state, op.trackId)}"`
    case 'clip/create':
      return `Added clip "${op.clip.name}" to "${trackName(state, op.clip.trackId)}"`
    case 'clip/delete':
      return `Deleted clip "${clipName(state, op.clipId)}"`
    case 'clip/move': {
      const clip = state.clips[op.clipId]
      const moved = `Moved clip "${clipName(state, op.clipId)}"`
      if (clip && clip.trackId !== op.trackId) {
        return `${moved} to "${trackName(state, op.trackId)}"`
      }
      return moved
    }
    case 'clip/resize':
      return `Resized clip "${clipName(state, op.clipId)}"`
    case 'clip/rename':
      return `Renamed clip "${clipName(state, op.clipId)}" to "${op.name}"`
    case 'file/create':
      return op.nodes.length === 1
        ? `Added ${op.nodes[0].kind === 'folder' ? 'folder' : 'file'} "${op.nodes[0].name}" to the File Bay`
        : `Added ${op.nodes.length} items to the File Bay`
    case 'file/delete':
      return op.nodeIds.length === 1
        ? `Removed "${fileName(state, op.nodeIds[0])}" from the File Bay`
        : `Removed ${op.nodeIds.length} items from the File Bay`
    case 'file/rename':
      return `Renamed "${fileName(state, op.nodeId)}" to "${op.name}"`
    case 'file/move':
      return `Moved "${fileName(state, op.nodeId)}" to "${
        op.parentId === null ? 'Project' : fileName(state, op.parentId)
      }"`
  }
}

function fileName(state: ProjectState, nodeId: string): string {
  return state.files[nodeId]?.name ?? 'unknown item'
}

function trackName(state: ProjectState, trackId: string): string {
  return state.tracks[trackId]?.name ?? 'unknown track'
}

function clipName(state: ProjectState, clipId: string): string {
  return state.clips[clipId]?.name ?? 'unknown clip'
}
