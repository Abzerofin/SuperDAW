import type { ProjectState } from '../model/types'
import { SYNTH_DEFS } from '../model/effects'
import { paramDefsOf } from '../plugins/builtin'
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
    case 'project/setTimeSignature':
      return `Set time signature to ${op.timeSignature[0]}/${op.timeSignature[1]}`
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
    case 'track/setParent':
      return op.parentId === null
        ? `Moved "${trackName(state, op.trackId)}" out of its folder`
        : `Moved "${trackName(state, op.trackId)}" into "${trackName(state, op.parentId)}"`
    case 'track/freeze':
      return `Froze track "${trackName(state, op.trackId)}"`
    case 'track/unfreeze':
      return `Unfroze track "${trackName(state, op.trackId)}"`
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
    case 'note/add':
      return `Added a note to "${clipName(state, op.note.clipId)}"`
    case 'note/addMany': {
      const clipId = op.notes[0]?.clipId
      return clipId
        ? `Added ${op.notes.length} notes to "${clipName(state, clipId)}"`
        : 'Added notes'
    }
    case 'note/move': {
      const note = state.notes[op.noteId]
      return `Moved a note${note ? ` in "${clipName(state, note.clipId)}"` : ''}`
    }
    case 'note/resize': {
      const note = state.notes[op.noteId]
      return `Resized a note${note ? ` in "${clipName(state, note.clipId)}"` : ''}`
    }
    case 'note/setVelocity': {
      const note = state.notes[op.noteId]
      return `Set a note's velocity to ${op.velocity}${
        note ? ` in "${clipName(state, note.clipId)}"` : ''
      }`
    }
    case 'note/delete': {
      const first = state.notes[op.noteIds[0]]
      const suffix = first ? ` from "${clipName(state, first.clipId)}"` : ''
      return op.noteIds.length === 1
        ? `Deleted a note${suffix}`
        : `Deleted ${op.noteIds.length} notes${suffix}`
    }
    case 'plugin/add':
      return `Added ${op.instance.descriptor.name} to "${trackName(
        state,
        op.instance.trackId
      )}"`
    case 'plugin/remove': {
      const instance = state.plugins[op.instanceId]
      if (!instance) return null
      return `Removed ${instance.descriptor.name} from "${trackName(state, instance.trackId)}"`
    }
    case 'plugin/setParam': {
      const instance = state.plugins[op.instanceId]
      if (!instance) return null
      const def = paramDefsOf(instance.descriptor)?.[op.param]
      return `Set ${instance.descriptor.name} ${def?.label ?? op.param} on "${trackName(
        state,
        instance.trackId
      )}"`
    }
    case 'plugin/setEnabled': {
      const instance = state.plugins[op.instanceId]
      if (!instance) return null
      return `${op.enabled ? 'Enabled' : 'Bypassed'} ${instance.descriptor.name} on "${trackName(
        state,
        instance.trackId
      )}"`
    }
    case 'track/setSynthParam': {
      const def = SYNTH_DEFS[op.param]
      return `Set synth ${def?.label ?? op.param} on "${trackName(state, op.trackId)}"`
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
    case 'clip/setColor':
      return `Recolored clip "${clipName(state, op.clipId)}"`
    case 'clip/setFades':
      return `Adjusted fades on clip "${clipName(state, op.clipId)}"`
    case 'clip/setPlayback': {
      // One op covers three settings: name whichever actually changed.
      const clip = state.clips[op.clipId]
      const name = clipName(state, op.clipId)
      if (clip && clip.reverse !== op.reverse) {
        return `${op.reverse ? 'Reversed' : 'Un-reversed'} clip "${name}"`
      }
      if (clip && clip.pitch !== op.pitch) {
        return `Pitched clip "${name}" to ${op.pitch > 0 ? '+' : ''}${op.pitch} st`
      }
      if (clip && clip.stretch !== op.stretch) {
        return `Stretched clip "${name}" to ${Math.round(op.stretch * 100)}%`
      }
      return `Changed playback of clip "${name}"`
    }
    case 'clip/split':
      return `Split clip "${clipName(state, op.clipId)}"`
    case 'clip/merge':
      return `Merged clip "${clipName(state, op.rightClipId)}" into "${clipName(state, op.clipId)}"`
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
