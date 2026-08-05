import type { FileNode, Note, ProjectState } from '../model/types'
import { clipsOfTrack, effectsOfTrack, notesOfClip, subtreeOf } from '../model/types'

function automationOfTrack(state: ProjectState, trackId: string) {
  return Object.values(state.automation).filter((p) => p.trackId === trackId)
}

function notesOfTrack(state: ProjectState, trackId: string): Note[] {
  return Object.values(state.notes).filter(
    (n) => state.clips[n.clipId]?.trackId === trackId
  )
}
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
        clips: clipsOfTrack(state, op.trackId),
        automation: automationOfTrack(state, op.trackId),
        notes: notesOfTrack(state, op.trackId),
        effects: effectsOfTrack(state, op.trackId)
      }
    }

    case 'track/setVolume': {
      const track = state.tracks[op.trackId]
      if (!track) return null
      return { type: 'track/setVolume', trackId: op.trackId, volume: track.volume }
    }

    case 'track/setPan': {
      const track = state.tracks[op.trackId]
      if (!track) return null
      return { type: 'track/setPan', trackId: op.trackId, pan: track.pan }
    }

    case 'project/setMasterVolume':
      return { type: 'project/setMasterVolume', volume: state.masterVolume }

    case 'automation/add':
      return { type: 'automation/delete', pointId: op.point.id }

    case 'automation/move': {
      const point = state.automation[op.pointId]
      if (!point) return null
      return { type: 'automation/move', pointId: op.pointId, ticks: point.ticks, value: point.value }
    }

    case 'automation/delete': {
      const point = state.automation[op.pointId]
      if (!point) return null
      return { type: 'automation/add', point }
    }

    case 'note/add':
      return { type: 'note/delete', noteIds: [op.note.id] }

    case 'note/addMany':
      return { type: 'note/delete', noteIds: op.notes.map((n) => n.id) }

    case 'note/move': {
      const note = state.notes[op.noteId]
      if (!note) return null
      return { type: 'note/move', noteId: op.noteId, pitch: note.pitch, start: note.start }
    }

    case 'note/resize': {
      const note = state.notes[op.noteId]
      if (!note) return null
      return { type: 'note/resize', noteId: op.noteId, duration: note.duration }
    }

    case 'note/delete': {
      const notes = op.noteIds
        .map((id) => state.notes[id])
        .filter((n): n is Note => n !== undefined)
      if (notes.length === 0) return null
      return { type: 'note/addMany', notes }
    }

    case 'effect/add':
      return { type: 'effect/remove', effectId: op.effect.id }

    case 'effect/remove': {
      const effect = state.effects[op.effectId]
      if (!effect) return null
      return { type: 'effect/add', effect }
    }

    case 'effect/setParam': {
      const effect = state.effects[op.effectId]
      if (!effect) return null
      return {
        type: 'effect/setParam',
        effectId: op.effectId,
        param: op.param,
        value: effect.params[op.param] ?? 0
      }
    }

    case 'effect/setEnabled': {
      const effect = state.effects[op.effectId]
      if (!effect) return null
      return { type: 'effect/setEnabled', effectId: op.effectId, enabled: effect.enabled }
    }

    case 'track/setSynthParam': {
      const track = state.tracks[op.trackId]
      if (!track) return null
      return {
        type: 'track/setSynthParam',
        trackId: op.trackId,
        param: op.param,
        value: track.synth[op.param] ?? 0
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
      return { type: 'clip/create', clip, notes: notesOfClip(state, op.clipId) }
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

    case 'file/create':
      return { type: 'file/delete', nodeIds: op.nodes.map((n) => n.id) }

    case 'file/delete': {
      const nodes: FileNode[] = []
      const seen = new Set<string>()
      for (const nodeId of op.nodeIds) {
        for (const node of subtreeOf(state, nodeId)) {
          if (!seen.has(node.id)) {
            seen.add(node.id)
            nodes.push(node)
          }
        }
      }
      if (nodes.length === 0) return null
      return { type: 'file/create', nodes }
    }

    case 'file/rename': {
      const node = state.files[op.nodeId]
      if (!node) return null
      return { type: 'file/rename', nodeId: op.nodeId, name: node.name }
    }

    case 'file/move': {
      const node = state.files[op.nodeId]
      if (!node) return null
      return { type: 'file/move', nodeId: op.nodeId, parentId: node.parentId }
    }

    // Chat is conversation, not editing: deliberately not undoable.
    case 'chat/post':
      return null

    case 'comment/add':
      return op.comments.length > 0 ? { type: 'comment/delete', commentId: op.comments[0].id } : null

    case 'comment/delete': {
      const target = state.comments[op.commentId]
      if (!target) return null
      const thread = [
        target,
        ...Object.values(state.comments).filter((c) => c.parentId === op.commentId)
      ]
      return { type: 'comment/add', comments: thread }
    }

    case 'comment/setResolved': {
      const comment = state.comments[op.commentId]
      if (!comment) return null
      return { type: 'comment/setResolved', commentId: op.commentId, resolved: comment.resolved }
    }
  }
}
