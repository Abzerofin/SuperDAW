import type { ProjectState } from '../model/types'
import { SYNTH_DEFS } from '../model/effects'
import {
  patchKeys,
  sanitizeSettingsPatch,
  type ProjectSettings
} from '../model/projectSettings'
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
    case 'project/setLyrics':
      return 'Edited lyrics'
    case 'project/setTempo':
      return op.conform && op.conform.length > 0
        ? `Set tempo to ${op.tempo} BPM, stretching audio to follow`
        : `Set tempo to ${op.tempo} BPM`
    case 'project/setTimeSignature':
      return `Set time signature to ${op.timeSignature[0]}/${op.timeSignature[1]}`
    case 'project/updateSettings': {
      const patch = sanitizeSettingsPatch(op.patch)
      const keys = patchKeys(patch)
      if (keys.length === 0) return null
      if (keys.length > 1) return 'Changed project settings'
      return describeSetting(keys[0], patch)
    }
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
    case 'track/group':
      return `Grouped ${op.trackIds.length} track${op.trackIds.length === 1 ? '' : 's'} into "${op.folder.name}"`
    case 'track/ungroup':
      return `Ungrouped "${trackName(state, op.folderId)}"`
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
    case 'note/moveMany': {
      const first = state.notes[op.moves[0]?.noteId]
      const suffix = first ? ` in "${clipName(state, first.clipId)}"` : ''
      return `Moved ${op.moves.length} notes${suffix}`
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
    case 'plugin/setParams': {
      const instance = state.plugins[op.instanceId]
      if (!instance) return null
      return `Adjusted ${instance.descriptor.name} on "${trackName(state, instance.trackId)}"`
    }
    case 'plugin/setEnabled': {
      const instance = state.plugins[op.instanceId]
      if (!instance) return null
      return `${op.enabled ? 'Enabled' : 'Bypassed'} ${instance.descriptor.name} on "${trackName(
        state,
        instance.trackId
      )}"`
    }
    case 'plugin/reorder': {
      if (!state.tracks[op.trackId]) return null
      return `Reordered effects on "${trackName(state, op.trackId)}"`
    }
    case 'plugin/setState': {
      const instance = state.plugins[op.instanceId]
      if (!instance) return null
      return `Adjusted ${instance.descriptor.name} settings on "${trackName(
        state,
        instance.trackId
      )}"`
    }
    case 'route/addMany': {
      const trackId = op.routes[0]?.trackId
      if (!trackId || !state.tracks[trackId]) return null
      return op.routes.length === 1
        ? `Connected effects on "${trackName(state, trackId)}"`
        : `Rewired effect routing on "${trackName(state, trackId)}"`
    }
    case 'route/deleteMany': {
      const trackId = op.routeIds.map((id) => state.routes[id]?.trackId).find((t) => t)
      if (!trackId || !state.tracks[trackId]) return null
      return op.routeIds.length === 1
        ? `Disconnected effects on "${trackName(state, trackId)}"`
        : `Cleared effect routing on "${trackName(state, trackId)}"`
    }
    // Node positions are pure layout — keep them out of the activity feed.
    case 'plugin/setGraphPos':
    case 'track/setGraphTerminal':
      return null
    case 'clip/restore':
      return `Restored clip "${clipName(state, op.clipId)}" to an earlier state`
    case 'track/restore':
      return `Restored track "${trackName(state, op.trackId)}" to an earlier state`
    case 'plugin/restore': {
      const instance = state.plugins[op.instanceId]
      if (!instance) return null
      return `Restored ${instance.descriptor.name} on "${trackName(state, instance.trackId)}" to an earlier state`
    }
    case 'track/setSynthParam': {
      const def = SYNTH_DEFS[op.param]
      const name = trackName(state, op.trackId)
      if (op.param === 'present') {
        return op.value >= 0.5 ? `Added the synth to "${name}"` : `Removed the synth from "${name}"`
      }
      if (op.param === 'on') {
        return op.value >= 0.5 ? `Enabled the synth on "${name}"` : `Bypassed the synth on "${name}"`
      }
      return `Set synth ${def?.label ?? op.param} on "${name}"`
    }
    case 'track/setSynthParams': {
      const name = trackName(state, op.trackId)
      if (op.params.present !== undefined) {
        return op.params.present >= 0.5
          ? `Added the synth to "${name}"`
          : `Removed the synth from "${name}"`
      }
      return `Adjusted the synth on "${name}"`
    }
    case 'track/setSampler': {
      const name = trackName(state, op.trackId)
      return op.assetId !== null
        ? `Loaded a sample into the sampler on "${name}"`
        : `Cleared the sampler on "${name}"`
    }
    case 'pad/set':
      return op.pad.name !== ''
        ? `Assigned pad ${op.pad.row + 1}·${op.pad.col + 1} to "${op.pad.name}"`
        : `Assigned pad ${op.pad.row + 1}·${op.pad.col + 1}`
    case 'pad/clear': {
      const pad = state.pads[op.padId]
      return pad ? `Cleared pad ${pad.row + 1}·${pad.col + 1}` : null
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
    case 'clip/resize': {
      if (op.stretch !== undefined) return `Stretched clip "${clipName(state, op.clipId)}"`
      if (op.loopLength === undefined) return `Resized clip "${clipName(state, op.clipId)}"`
      return op.loopLength > 0
        ? `Looped clip "${clipName(state, op.clipId)}"`
        : `Unlooped clip "${clipName(state, op.clipId)}"`
    }
    case 'clip/resizeWithNotes': {
      const name = clipName(state, op.clipId)
      if (op.notes.length === 0) return `Resized clip "${name}"`
      return op.notes.length === 1
        ? `Programmed a step past the end of "${name}"`
        : `Programmed ${op.notes.length} steps past the end of "${name}"`
    }
    case 'clip/deleteMany': {
      if (op.clipIds.length === 0) return null
      if (op.clipIds.length === 1) return `Deleted clip "${clipName(state, op.clipIds[0])}"`
      return `Deleted ${op.clipIds.length} clips`
    }
    case 'clip/createMany': {
      if (op.clips.length === 0) return null
      if (op.clips.length === 1) return `Added clip "${op.clips[0].name}"`
      return `Added ${op.clips.length} clips`
    }
    case 'clip/moveMany': {
      if (op.moves.length === 0) return null
      if (op.moves.length === 1) {
        return `Moved clip "${clipName(state, op.moves[0].clipId)}"`
      }
      return `Moved ${op.moves.length} clips`
    }
    case 'clip/resizeMany': {
      if (op.edits.length === 0) return null
      if (op.edits.length === 1) return `Resized clip "${clipName(state, op.edits[0].clipId)}"`
      const looped = op.edits.every((e) => e.loopLength !== undefined)
      return `${looped ? 'Looped' : 'Resized'} ${op.edits.length} clips`
    }
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
    case 'clip/slice': {
      const cuts = op.slices.reduce((n, s) => n + s.newClipIds.length, 0)
      if (cuts === 0) return null
      if (op.slices.length === 1) {
        const name = clipName(state, op.slices[0].clipId)
        return cuts === 1
          ? `Sliced clip "${name}"`
          : `Sliced clip "${name}" into ${cuts + 1} parts`
      }
      return `Sliced ${op.slices.length} clips into ${cuts / op.slices.length + 1} parts`
    }
    case 'clip/unslice': {
      if (op.merges.length === 0) return null
      return op.merges.length === 1
        ? `Rejoined clip "${clipName(state, op.merges[0].clipId)}"`
        : `Rejoined ${op.merges.length} clips`
    }
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

/** One touched setting → a specific feed line (the common single-field case). */
function describeSetting(
  key: keyof ProjectSettings,
  patch: Partial<ProjectSettings>
): string {
  switch (key) {
    case 'loudnessTargetLufs': {
      const target = patch.loudnessTargetLufs
      return target === null || target === undefined
        ? 'Cleared the loudness target'
        : `Set loudness target to ${target} LUFS`
    }
    case 'defaultFadeTicks':
      return patch.defaultFadeTicks === 0
        ? 'Turned off default clip fades'
        : `Set default clip fades to ${patch.defaultFadeTicks} ticks`
    case 'swingPercent':
      return patch.swingPercent === 0
        ? 'Set quantize swing to straight'
        : `Set quantize swing to ${patch.swingPercent}%`
    case 'quantizeStrength':
      return `Set quantize strength to ${Math.round((patch.quantizeStrength ?? 1) * 100)}%`
    case 'humanizeTicks':
      return `Set humanize amount to ±${patch.humanizeTicks} ticks`
    case 'defaultGrid':
      return `Set the project's default grid to ${patch.defaultGrid}`
    case 'exportFormat':
      return `Set default export format to ${patch.exportFormat?.toUpperCase()}`
    case 'exportBitDepth':
      return `Set export bit depth to ${patch.exportBitDepth}-bit`
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
