import type { Clip, ClipId, ProjectState } from '../model/types'
import { takeGroupMembers, timelineClips } from '../model/types'
import { newId } from '../model/ids'
import type { Operation, TakeFieldEntry } from './operations'

/**
 * Take-group building blocks — pure, so recording commit, the timeline's
 * gestures and the tests all run one definition. Like buildMidiTakeOp and
 * buildDuplicateTrackOp these are deliberately NOT new op machinery: they
 * materialize ids and absolute field sets client-side and ship existing
 * ops, so idempotent re-delivery, exact inverts and sync apply unchanged.
 */

/** Clips on the clip's track whose windows overlap it (patterns excluded). */
export function overlappingClips(state: ProjectState, clip: Clip): Clip[] {
  return timelineClips(state).filter(
    (c) =>
      c.id !== clip.id &&
      c.trackId === clip.trackId &&
      c.start < clip.start + clip.duration &&
      c.start + c.duration > clip.start
  )
}

/**
 * Comp a freshly recorded clip against what already sits under it — the
 * shared half of the audio AND MIDI recording commits. When the new clip
 * overlaps nothing, it records exactly as before (`takes` empty, clip
 * untouched). When it overlaps existing material, the new clip joins the
 * take group under it (or forms one) as THE active take, and every other
 * member — including the previously active take, and any overlapping
 * loose clip pulled into the group — is stamped inactive, all absolute,
 * so the caller can carry it inside its one `clip/create` per take.
 */
export function takeCompForClip(
  state: ProjectState,
  clip: Clip
): { clip: Clip; takes: TakeFieldEntry[] } {
  const overlaps = overlappingClips(state, clip)
  if (overlaps.length === 0) return { clip, takes: [] }
  // Join the group already under the take region if there is one; the
  // earliest (start, id) grouped overlap decides, deterministically.
  const grouped = overlaps
    .filter((c) => c.takeGroupId)
    .sort((a, b) => a.start - b.start || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  const groupId = grouped[0]?.takeGroupId ?? newId('tkg')
  const members = new Map<ClipId, Clip>()
  for (const member of takeGroupMembers(state, groupId)) members.set(member.id, member)
  for (const c of overlaps) members.set(c.id, c)
  return {
    clip: { ...clip, takeGroupId: groupId, takeActive: true },
    takes: [...members.keys()].map((clipId) => ({ clipId, groupId, active: false }))
  }
}

/**
 * Make one member of a take group THE audible take: absolute flags for
 * every member in ONE op (whole-group last-write-wins under concurrency).
 * Null when the clip is not a group member.
 */
export function buildActivateTakeOp(state: ProjectState, clipId: ClipId): Operation | null {
  const clip = state.clips[clipId]
  if (!clip || !clip.takeGroupId) return null
  const members = takeGroupMembers(state, clip.takeGroupId)
  if (members.length === 0) return null
  return {
    type: 'take/activate',
    groupId: clip.takeGroupId,
    clips: members.map((m) => ({ clipId: m.id, active: m.id === clipId }))
  }
}

/**
 * Group clips as takes of one region — the manual gesture over overlapping
 * clips (or a multi-selection). Validates here, not in the reducer: at
 * least two clips, all existing, all on ONE track, none of them patterns.
 * Clips already in another group are re-stamped (absolute wins). The
 * clicked clip becomes the active take.
 */
export function buildGroupTakesOp(
  state: ProjectState,
  clipIds: readonly ClipId[],
  activeClipId: ClipId
): Operation | null {
  const clips = clipIds.map((id) => state.clips[id]).filter((c): c is Clip => c !== undefined)
  if (clips.length < 2) return null
  if (clips.some((c) => c.isPattern)) return null
  const trackId = clips[0].trackId
  if (clips.some((c) => c.trackId !== trackId)) return null
  if (!clips.some((c) => c.id === activeClipId)) return null
  const groupId = newId('tkg')
  return {
    type: 'take/setGroups',
    entries: clips.map((c) => ({ clipId: c.id, groupId, active: c.id === activeClipId }))
  }
}

/**
 * Dissolve a take group: every member back to an ordinary clip (all of
 * them audible again). Absolute clears; the invert restores each member's
 * exact previous membership and active flag.
 */
export function buildUngroupTakesOp(state: ProjectState, groupId: string): Operation | null {
  const members = takeGroupMembers(state, groupId)
  if (members.length === 0) return null
  return {
    type: 'take/setGroups',
    entries: members.map((m) => ({ clipId: m.id, groupId: null, active: false }))
  }
}

/**
 * Flatten a take group down to one clip: keep `keepClipId`, delete every
 * other member, and clear the kept clip's membership — ONE op (the plural
 * delete carrying the membership clear), so one undo restores the deleted
 * takes AND the kept clip's previous group state together.
 */
export function buildFlattenTakesOp(state: ProjectState, keepClipId: ClipId): Operation | null {
  const keep = state.clips[keepClipId]
  if (!keep || !keep.takeGroupId) return null
  const others = takeGroupMembers(state, keep.takeGroupId).filter((m) => m.id !== keepClipId)
  // A group already down to one member: flattening is just ungrouping.
  if (others.length === 0) return buildUngroupTakesOp(state, keep.takeGroupId)
  return {
    type: 'clip/deleteMany',
    clipIds: others.map((m) => m.id),
    takes: [{ clipId: keepClipId, groupId: null, active: false }]
  }
}
