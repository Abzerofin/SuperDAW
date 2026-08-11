import type { FileNode, Note, ProjectState } from '../model/types'
import {
  clipsOfTrack,
  pluginsOfTrack,
  notesOfClip,
  routesOfTrack,
  subtreeOf,
  trackSubtreeOf
} from '../model/types'
import { SYNTH_DEFS } from '../model/effects'
import {
  patchKeys,
  sanitizeSettingsPatch,
  type ProjectSettings
} from '../model/projectSettings'

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

    case 'project/setLyrics':
      return { type: 'project/setLyrics', lyrics: state.lyrics }

    case 'project/setTempo': {
      // Undo restores the previous stretch of every clip the op conforms.
      const conform = (op.conform ?? [])
        .filter((entry) => state.clips[entry.clipId])
        .map((entry) => ({ clipId: entry.clipId, stretch: state.clips[entry.clipId].stretch }))
      return {
        type: 'project/setTempo',
        tempo: state.tempo,
        ...(conform.length > 0 ? { conform } : {})
      }
    }

    case 'project/setTimeSignature':
      return { type: 'project/setTimeSignature', timeSignature: state.timeSignature }

    case 'project/updateSettings': {
      // Undo restores the previous values of exactly the keys the sanitized
      // patch would touch (keys the reducer drops must not resurrect here).
      const patch: Record<string, unknown> = {}
      for (const key of patchKeys(sanitizeSettingsPatch(op.patch))) {
        patch[key] = state.settings[key]
      }
      return { type: 'project/updateSettings', patch: patch as Partial<ProjectSettings> }
    }

    case 'track/create':
      return { type: 'track/delete', trackId: op.track.id }

    case 'track/delete': {
      const track = state.tracks[op.trackId]
      if (!track) return null
      // The delete cascades over the subtree; restore every member (each
      // at its original trackOrder index) plus all their content.
      const subtree = trackSubtreeOf(state, op.trackId)
      const rest = subtree.filter((t) => t.id !== op.trackId)
      const routes = subtree.flatMap((t) => routesOfTrack(state, t.id))
      return {
        type: 'track/create',
        track,
        index: state.trackOrder.indexOf(op.trackId),
        clips: subtree.flatMap((t) => clipsOfTrack(state, t.id)),
        automation: subtree.flatMap((t) => automationOfTrack(state, t.id)),
        notes: subtree.flatMap((t) => notesOfTrack(state, t.id)),
        plugins: subtree.flatMap((t) => pluginsOfTrack(state, t.id)),
        ...(routes.length > 0 ? { routes } : {}),
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

    case 'note/moveMany': {
      const moves = op.moves
        .filter((m) => state.notes[m.noteId])
        .map((m) => ({
          noteId: m.noteId,
          pitch: state.notes[m.noteId].pitch,
          start: state.notes[m.noteId].start
        }))
      if (moves.length === 0) return null
      return { type: 'note/moveMany', moves }
    }

    case 'note/resize': {
      const note = state.notes[op.noteId]
      if (!note) return null
      // Start always carried, so undoing a left-edge trim restores it exactly.
      return { type: 'note/resize', noteId: op.noteId, duration: note.duration, start: note.start }
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
      return {
        type: 'plugin/remove',
        instanceId: op.instance.id,
        ...(op.severedRoutes && op.severedRoutes.length > 0
          ? { restoreRoutes: op.severedRoutes }
          : {})
      }

    case 'plugin/remove': {
      const instance = state.plugins[op.instanceId]
      if (!instance) return null
      // The remove cascades away the node's routing edges and parameter
      // automation; carry both so undo restores everything, not just the node.
      const routes = Object.values(state.routes).filter(
        (r) => r.from === op.instanceId || r.to === op.instanceId
      )
      const automation = Object.values(state.automation).filter(
        (p) => p.instanceId === op.instanceId
      )
      return {
        type: 'plugin/add',
        instance,
        ...(routes.length > 0 ? { routes } : {}),
        ...(automation.length > 0 ? { automation } : {}),
        // A remove that heals severed edges inverts to the splice that cut
        // them, so redo severs them again.
        ...(op.restoreRoutes && op.restoreRoutes.length > 0
          ? { severedRoutes: op.restoreRoutes }
          : {})
      }
    }

    case 'route/addMany': {
      if (op.routes.length === 0) return null
      return { type: 'route/deleteMany', routeIds: op.routes.map((r) => r.id) }
    }

    case 'route/deleteMany': {
      const routes = op.routeIds
        .map((id) => state.routes[id])
        .filter((r): r is NonNullable<typeof r> => r !== undefined)
      if (routes.length === 0) return null
      return { type: 'route/addMany', routes }
    }

    case 'plugin/setGraphPos': {
      const instance = state.plugins[op.instanceId]
      if (!instance) return null
      // A node that was never placed has no position to restore — the
      // first placement is deliberately not undoable (cosmetic).
      if (instance.graphX === undefined || instance.graphY === undefined) return null
      return {
        type: 'plugin/setGraphPos',
        instanceId: op.instanceId,
        x: instance.graphX,
        y: instance.graphY
      }
    }

    case 'clip/restore': {
      const clip = state.clips[op.clipId]
      if (!clip) return null
      return { type: 'clip/restore', clipId: op.clipId, clip }
    }

    case 'track/restore': {
      const track = state.tracks[op.trackId]
      if (!track) return null
      return {
        type: 'track/restore',
        trackId: op.trackId,
        track: {
          name: track.name,
          color: track.color,
          muted: track.muted,
          soloed: track.soloed,
          volume: track.volume,
          pan: track.pan,
          synth: track.synth
        }
      }
    }

    case 'plugin/restore': {
      const instance = state.plugins[op.instanceId]
      if (!instance) return null
      return {
        type: 'plugin/restore',
        instanceId: op.instanceId,
        params: { ...instance.params },
        enabled: instance.enabled,
        stateBlob: instance.stateBlob
      }
    }

    case 'track/setGraphTerminal': {
      const track = state.tracks[op.trackId]
      if (!track) return null
      const x = op.terminal === 'in' ? track.graphInX : track.graphOutX
      const y = op.terminal === 'in' ? track.graphInY : track.graphOutY
      // Same convention as plugin/setGraphPos: the first placement has no
      // position to restore and is deliberately not undoable (cosmetic).
      if (x === undefined || y === undefined) return null
      return { type: 'track/setGraphTerminal', trackId: op.trackId, terminal: op.terminal, x, y }
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

    case 'plugin/setParams': {
      const instance = state.plugins[op.instanceId]
      if (!instance) return null
      return {
        type: 'plugin/setParams',
        instanceId: op.instanceId,
        params: Object.fromEntries(
          Object.keys(op.params).map((key) => [key, instance.params[key] ?? 0])
        )
      }
    }

    case 'plugin/setEnabled': {
      const instance = state.plugins[op.instanceId]
      if (!instance) return null
      return { type: 'plugin/setEnabled', instanceId: op.instanceId, enabled: instance.enabled }
    }

    case 'plugin/reorder': {
      const order = pluginsOfTrack(state, op.trackId).map((p) => p.id)
      if (order.length === 0) return null
      return { type: 'plugin/reorder', trackId: op.trackId, order }
    }

    case 'plugin/setState': {
      const instance = state.plugins[op.instanceId]
      if (!instance) return null
      return {
        type: 'plugin/setState',
        instanceId: op.instanceId,
        stateBlob: instance.stateBlob
      }
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

    case 'track/setSynthParams': {
      const track = state.tracks[op.trackId]
      if (!track) return null
      return {
        type: 'track/setSynthParams',
        trackId: op.trackId,
        params: Object.fromEntries(
          Object.keys(op.params).map((param) => [
            param,
            track.synth[param] ?? SYNTH_DEFS[param]?.default ?? 0
          ])
        )
      }
    }

    case 'track/setSampler': {
      const track = state.tracks[op.trackId]
      if (!track) return null
      const params = op.params
        ? Object.fromEntries(
            Object.keys(op.params).map((param) => [
              param,
              track.synth[param] ?? SYNTH_DEFS[param]?.default ?? 0
            ])
          )
        : undefined
      return {
        type: 'track/setSampler',
        trackId: op.trackId,
        assetId: track.samplerAssetId ?? null,
        ...(params ? { params } : {})
      }
    }

    case 'pad/set': {
      const existing = state.pads[op.pad.id]
      return existing
        ? { type: 'pad/set', pad: existing }
        : { type: 'pad/clear', padId: op.pad.id }
    }

    case 'pad/clear': {
      const existing = state.pads[op.padId]
      if (!existing) return null
      return { type: 'pad/set', pad: existing }
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

    case 'track/group': {
      // Record where each member sat BEFORE the folder existed, so ungroup
      // puts them back exactly (order included, not just parentage).
      const restore = op.trackIds
        .filter((id) => state.tracks[id])
        .map((id) => ({
          trackId: id,
          parentId: state.tracks[id].parentId,
          index: state.trackOrder.indexOf(id)
        }))
        .filter((entry) => entry.index !== -1)
      if (restore.length === 0) return null
      return { type: 'track/ungroup', folderId: op.folder.id, restore }
    }

    case 'track/ungroup': {
      const folder = state.tracks[op.folderId]
      if (!folder) return null
      const trackIds = state.trackOrder.filter(
        (id) => state.tracks[id]?.parentId === op.folderId
      )
      if (trackIds.length === 0) return null
      return {
        type: 'track/group',
        folder,
        index: state.trackOrder.indexOf(op.folderId),
        trackIds
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

    case 'clip/deleteMany': {
      const clips = op.clipIds
        .map((id) => state.clips[id])
        .filter((c): c is NonNullable<typeof c> => c !== undefined)
      if (clips.length === 0) return null
      return {
        type: 'clip/createMany',
        clips,
        notes: clips.flatMap((c) => notesOfClip(state, c.id))
      }
    }

    case 'clip/createMany': {
      const clipIds = op.clips.map((c) => c.id)
      if (clipIds.length === 0) return null
      return { type: 'clip/deleteMany', clipIds }
    }

    case 'clip/moveMany': {
      const moves = op.moves
        .filter((m) => state.clips[m.clipId])
        .map((m) => ({
          clipId: m.clipId,
          trackId: state.clips[m.clipId].trackId,
          start: state.clips[m.clipId].start
        }))
      if (moves.length === 0) return null
      return { type: 'clip/moveMany', moves }
    }

    case 'clip/resizeMany': {
      const edits = op.edits
        .filter((e) => state.clips[e.clipId])
        .map((e) => {
          const clip = state.clips[e.clipId]
          return {
            clipId: e.clipId,
            start: clip.start,
            duration: clip.duration,
            offset: clip.offset,
            // Always carried, as in clip/resize: undoing a loop- or
            // stretch-handle drag must restore that state exactly.
            loopLength: clip.loopLength,
            stretch: clip.stretch
          }
        })
      if (edits.length === 0) return null
      return { type: 'clip/resizeMany', edits }
    }

    case 'clip/resize': {
      const clip = state.clips[op.clipId]
      if (!clip) return null
      return {
        type: 'clip/resize',
        clipId: op.clipId,
        start: clip.start,
        duration: clip.duration,
        offset: clip.offset,
        // Always carried, so undoing a loop- or stretch-handle drag restores
        // that state exactly whatever the forward op set.
        loopLength: clip.loopLength,
        stretch: clip.stretch
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

    case 'clip/slice': {
      const merges = op.slices
        .filter((s) => state.clips[s.clipId] && s.newClipIds.length > 0)
        // Absorb right-to-left: each merge extends the source clip to the
        // piece's end, so the original length comes back one cut at a time.
        .map((s) => ({ clipId: s.clipId, pieceIds: [...s.newClipIds].reverse() }))
      if (merges.length === 0) return null
      return { type: 'clip/unslice', merges }
    }

    case 'clip/unslice': {
      const slices = op.merges
        .map((m) => {
          const pieces = m.pieceIds
            .map((id) => state.clips[id])
            .filter((c): c is NonNullable<typeof c> => c !== undefined)
            .sort((a, b) => a.start - b.start)
          return {
            clipId: m.clipId,
            at: pieces.map((p) => p.start),
            newClipIds: pieces.map((p) => p.id)
          }
        })
        .filter((s) => s.at.length > 0)
      if (slices.length === 0) return null
      return { type: 'clip/slice', slices }
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
