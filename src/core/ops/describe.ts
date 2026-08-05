import type { ProjectState } from '../model/types'
import type { Operation } from './operations'

/**
 * Human-readable description of an operation, evaluated against the state
 * *before* the op is applied (so deletions can name what they removed).
 * Feeds the activity feed. Returns null for ops that deliberately stay out
 * of the feed (chat has its own panel).
 */
export function describe(state: ProjectState, op: Operation): string | null {
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
    case 'track/setVolume':
      return `Set "${trackName(state, op.trackId)}" volume to ${gainToDb(op.volume)}`
    case 'track/setPan':
      return `Panned "${trackName(state, op.trackId)}" ${panLabel(op.pan)}`
    case 'project/setMasterVolume':
      return `Set master volume to ${gainToDb(op.volume)}`
    case 'automation/add':
      return `Added automation point on "${trackName(state, op.point.trackId)}"`
    case 'automation/move': {
      const point = state.automation[op.pointId]
      return `Moved automation point${point ? ` on "${trackName(state, point.trackId)}"` : ''}`
    }
    case 'automation/delete': {
      const point = state.automation[op.pointId]
      return `Deleted automation point${point ? ` on "${trackName(state, point.trackId)}"` : ''}`
    }
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
    case 'chat/post':
      return null
    case 'comment/add': {
      const root = op.comments[0]
      if (!root) return null
      if (root.parentId !== null) return 'Replied to a comment'
      return `Commented on ${anchorName(state, root.anchor.kind, root.anchor.id)}`
    }
    case 'comment/delete': {
      const comment = state.comments[op.commentId]
      if (!comment) return null
      return `Deleted a comment on ${anchorName(state, comment.anchor.kind, comment.anchor.id)}`
    }
    case 'comment/setResolved': {
      const comment = state.comments[op.commentId]
      if (!comment) return null
      return `${op.resolved ? 'Resolved' : 'Reopened'} a comment on ${anchorName(
        state,
        comment.anchor.kind,
        comment.anchor.id
      )}`
    }
  }
}

function anchorName(state: ProjectState, kind: 'clip' | 'track' | 'file', id: string): string {
  if (kind === 'clip') return `clip "${clipName(state, id)}"`
  if (kind === 'track') return `track "${trackName(state, id)}"`
  return `file "${state.files[id]?.name ?? 'unknown'}"`
}

function fileName(state: ProjectState, nodeId: string): string {
  return state.files[nodeId]?.name ?? 'unknown item'
}

function gainToDb(gain: number): string {
  if (gain <= 0.0001) return '-∞ dB'
  const db = 20 * Math.log10(gain)
  return `${db >= 0 ? '+' : ''}${db.toFixed(1)} dB`
}

function panLabel(pan: number): string {
  if (Math.abs(pan) < 0.01) return 'center'
  const pct = Math.round(Math.abs(pan) * 100)
  return pan < 0 ? `${pct}% left` : `${pct}% right`
}

function trackName(state: ProjectState, trackId: string): string {
  return state.tracks[trackId]?.name ?? 'unknown track'
}

function clipName(state: ProjectState, clipId: string): string {
  return state.clips[clipId]?.name ?? 'unknown clip'
}
