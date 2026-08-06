import type { FileNode, Note, ProjectState } from '../model/types'
import {
  clipsOfTrack,
  pluginsOfTrack,
  notesOfClip,
  subtreeOf,
  trackSubtreeOf
} from '../model/types'

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

    case 'project/setTimeSignature':
      return { type: 'project/setTimeSignature', timeSignature: state.timeSignature }

    case 'track/create':
      return { type: 'track/delete', trackId: op.track.id }

    case 'track/delete': {
      const track = state.tracks[op.trackId]
      if (!track) return null
      // The delete cascades over the subtree; restore every member (each
      // at its original trackOrder index) plus all their content.
      const subtree = trackSubtreeOf(state, op.trackId)
      const rest = subtree.filter((t) => t.id !== op.trackId)
      return {
        type: 'track/create',
        track,
        index: state.trackOrder.indexOf(op.trackId),
        clips: subtree.flatMap((t) => clipsOfTrack(state, t.id)),
        automation: subtree.flatMap((t) => automationOfTrack(state, t.id)),
        notes: subtree.flatMap((t) => notesOfTrack(state, t.id)),
        plugins: subtree.flatMap((t) => pluginsOfTrack(state, t.id)),
        ...(rest.length > 0
          ? { descendants: rest.map((t) => ({ track: t, index: state.trackOrder.indexOf(t.id) })) }
          : {})
      }
    }

    case 'track/setParent': {
      const track = state.tracks[op.trackId]
      if (!track) return null
      return { type: 'track/setParent', trackId: op.trackId, parentId: track.parentId }
    }

    case 'track/freeze': {
      const track = state.tracks[op.trackId]
      if (!track) return null
      return track.frozenAssetId === null
        ? { type: 'track/unfreeze', trackId: op.trackId }
        : { type: 'track/freeze', trackId: op.trackId, assetId: track.frozenAssetId }
    }

    case 'track/unfreeze': {
      const track = state.tracks[op.trackId]
      if (!track || track.frozenAssetId === null) return null
      return { type: 'track/freeze', trackId: op.trackId, assetId: track.frozenAssetId }
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

    case 'note/setVelocity': {
      const note = state.notes[op.noteId]
      if (!note) return null
      return { type: 'note/setVelocity', noteId: op.noteId, velocity: note.velocity }
    }

    case 'note/delete': {
      const notes = op.noteIds
        .map((id) => state.notes[id])
        .filter((n): n is Note => n !== undefined)
      if (notes.length === 0) return null
      return { type: 'note/addMany', notes }
    }

    case 'plugin/add':
      return { type: 'plugin/remove', instanceId: op.instance.id }

    case 'plugin/remove': {
      const instance = state.plugins[op.instanceId]
      if (!instance) return null
      return { type: 'plugin/add', instance }
    }

    case 'plugin/setParam': {
      const instance = state.plugins[op.instanceId]
      if (!instance) return null
      return {
        type: 'plugin/setParam',
        instanceId: op.instanceId,
        param: op.param,
        value: instance.params[op.param] ?? 0
      }
    }

    case 'plugin/setEnabled': {
      const instance = state.plugins[op.instanceId]
      if (!instance) return null
      return { type: 'plugin/setEnabled', instanceId: op.instanceId, enabled: instance.enabled }
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
      return {
        type: 'track/reorder',
        trackId: op.trackId,
        index,
        ...(op.parentId !== undefined
          ? { parentId: state.tracks[op.trackId]?.parentId ?? null }
          : {})
      }
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

    case 'clip/setColor': {
      const clip = state.clips[op.clipId]
      if (!clip) return null
      return { type: 'clip/setColor', clipId: op.clipId, color: clip.color }
    }

    case 'clip/setFades': {
      const clip = state.clips[op.clipId]
      if (!clip) return null
      return { type: 'clip/setFades', clipId: op.clipId, fadeIn: clip.fadeIn, fadeOut: clip.fadeOut }
    }

    case 'clip/setPlayback': {
      const clip = state.clips[op.clipId]
      if (!clip) return null
      return {
        type: 'clip/setPlayback',
        clipId: op.clipId,
        reverse: clip.reverse,
        pitch: clip.pitch,
        stretch: clip.stretch
      }
    }

    case 'clip/split': {
      const clip = state.clips[op.clipId]
      if (!clip) return null
      return { type: 'clip/merge', clipId: op.clipId, rightClipId: op.rightClipId }
    }

    case 'clip/merge': {
      const left = state.clips[op.clipId]
      const right = state.clips[op.rightClipId]
      if (!left || !right) return null
      // Reconstruct the right clip (and any gap/fades) exactly as it was.
      return {
        type: 'clip/split',
        clipId: op.clipId,
        at: right.start,
        rightClipId: right.id,
        rightName: right.name,
        rightColor: right.color,
        leftDuration: left.duration,
        rightFades: [right.fadeIn, right.fadeOut],
        leftFadeOut: left.fadeOut
      }
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
