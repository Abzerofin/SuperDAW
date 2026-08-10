import type { ProjectState, Track, TrackId } from '../model/types'
import {
  clipsOfTrack,
  notesOfClip,
  pluginsOfTrack,
  routesOfTrack,
  trackSubtreeOf
} from '../model/types'
import { newId } from '../model/ids'
import type { Operation } from './operations'

/**
 * Builds the operation that duplicates a track — or, for a folder, its
 * whole subtree. Deliberately NOT a `track/duplicate { trackId }` op:
 * applying that on each peer would mint different ids and diverge the
 * documents. Instead the duplicate is fully materialized here — fresh ids
 * for every track, clip, note, automation point and plugin instance, with
 * parent/clip references remapped — and shipped as a plain `track/create`
 * (+ `descendants`), so the existing reducer, invert (undo = delete),
 * activity description and sync all apply unchanged.
 */
export function buildDuplicateTrackOp(state: ProjectState, trackId: TrackId): Operation | null {
  const source = state.tracks[trackId]
  if (!source) return null

  const subtree = trackSubtreeOf(state, trackId)
  const trackIdMap = new Map<TrackId, TrackId>(subtree.map((t) => [t.id, newId('trk')]))

  const cloneTrack = (t: Track): Track => ({
    ...t,
    id: trackIdMap.get(t.id)!,
    name: t.id === trackId ? `${t.name} Copy` : t.name,
    // Parents inside the subtree remap; the root keeps its original parent.
    parentId: t.parentId !== null && trackIdMap.has(t.parentId) ? trackIdMap.get(t.parentId)! : t.parentId
  })

  const clips: ReturnType<typeof clipsOfTrack> = []
  const notes: ReturnType<typeof notesOfClip> = []
  const automation: import('../model/types').AutomationPoint[] = []
  const plugins: ReturnType<typeof pluginsOfTrack> = []
  const routes: ReturnType<typeof routesOfTrack> = []
  const pluginIdMap = new Map<string, string>()
  for (const t of subtree) {
    const newTrackId = trackIdMap.get(t.id)!
    for (const clip of clipsOfTrack(state, t.id)) {
      const newClipId = newId('clp')
      clips.push({ ...clip, id: newClipId, trackId: newTrackId })
      for (const note of notesOfClip(state, clip.id)) {
        notes.push({ ...note, id: newId('nte'), clipId: newClipId })
      }
    }
    for (const instance of pluginsOfTrack(state, t.id)) {
      const newInstanceId = newId('plg')
      pluginIdMap.set(instance.id, newInstanceId)
      plugins.push({ ...instance, id: newInstanceId, trackId: newTrackId })
    }
    // ALL of the track's points — volume/pan plus every insert's parameter
    // curves, the latter remapped onto the duplicated instances.
    for (const point of Object.values(state.automation)) {
      if (point.trackId !== t.id) continue
      automation.push({
        ...point,
        id: newId('aut'),
        trackId: newTrackId,
        ...(point.instanceId !== undefined
          ? { instanceId: pluginIdMap.get(point.instanceId) ?? point.instanceId }
          : {})
      })
    }
    // Routing edges follow their plugins ('in'/'out' terminals stay as-is).
    for (const route of routesOfTrack(state, t.id)) {
      routes.push({
        id: newId('rte'),
        trackId: newTrackId,
        from: route.from === 'in' ? 'in' : (pluginIdMap.get(route.from) ?? route.from),
        to: route.to === 'out' ? 'out' : (pluginIdMap.get(route.to) ?? route.to)
      })
    }
  }

  // The copy lands right after the original's subtree, mirroring its shape.
  const subtreeEnd = Math.max(...subtree.map((t) => state.trackOrder.indexOf(t.id)))
  const rest = subtree.filter((t) => t.id !== trackId)
  return {
    type: 'track/create',
    track: cloneTrack(source),
    index: subtreeEnd + 1,
    clips,
    automation,
    notes,
    plugins,
    ...(routes.length > 0 ? { routes } : {}),
    ...(rest.length > 0
      ? {
          descendants: rest.map((t, i) => ({ track: cloneTrack(t), index: subtreeEnd + 2 + i }))
        }
      : {})
  }
}
