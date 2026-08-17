import type {
  ProjectState,
  Track,
  Clip,
  TrackId,
  ClipId,
  Comment,
  FileNode,
  AutomationPoint,
  Note,
  PluginInstance,
  Route
} from '../model/types'
import { routeIsValid } from '../model/routing'
import {
  clipsOfTrack,
  isNoteTrackKind,
  isSelfOrDescendant,
  isTrackSelfOrDescendant,
  subtreeOf,
  MAX_GAIN,
  MAX_PITCH,
  MAX_STRETCH,
  MIN_PITCH,
  MIN_STRETCH,
  isClipLooped,
  markersEqual,
  MASTER_BUS_ID,
  normalizeLoop,
  padsEqual,
  pluginsOfTrack,
  sanitizeMarker,
  sanitizePad
} from '../model/types'
import { SYNTH_DEFS, clampParam, type ParamDef } from '../model/effects'
import { mergeSettings, sanitizeSettingsPatch } from '../model/projectSettings'
import { paramDefsOf } from '../plugins/builtin'
import {
  MAX_MACROS,
  canonicalMacros,
  macrosEqual,
  materializeMacros,
  sanitizeMacroTarget,
  type MacroTarget,
  type TrackMacro
} from '../model/macros'

/** Insert notes, skipping ids that exist and notes whose clip is missing. */
function withNotes(
  notes: Readonly<Record<string, Note>>,
  clips: Readonly<Record<string, Clip>>,
  incoming: readonly Note[]
): { notes: Record<string, Note>; changed: boolean } {
  const next = { ...notes }
  let changed = false
  for (const note of incoming) {
    if (next[note.id] || !clips[note.clipId]) continue
    next[note.id] = {
      ...note,
      pitch: clampInt(note.pitch, 0, 127),
      start: Math.max(0, note.start),
      duration: Math.max(1, note.duration),
      velocity: clampInt(note.velocity, 1, 127)
    }
    changed = true
  }
  return { notes: next, changed }
}

function clampInt(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)))
}


/**
 * With param defs (builtins, or external plugins that snapshotted defs):
 * exactly the defined params, each clamped. Without defs the params pass
 * through with only a finite-number guard — clamping must depend solely on
 * document data so every peer sanitizes identically.
 */
function sanitizeParams(
  defs: Readonly<Record<string, ParamDef>> | null,
  incoming: Readonly<Record<string, number>>
): Record<string, number> {
  const params: Record<string, number> = {}
  if (defs) {
    for (const [key, def] of Object.entries(defs)) {
      params[key] = clampParam(def, incoming[key] ?? def.default)
    }
    return params
  }
  for (const [key, value] of Object.entries(incoming)) {
    if (Number.isFinite(value)) params[key] = value
  }
  return params
}
import type { Operation } from './operations'

/**
 * The audio-clip offset changes a `project/setTempo` op produces — shared
 * by the reducer (to apply them) and invert (to list exact pre-values).
 *
 * An audio clip's `offset` is ticks of trim into its SOURCE, and ticks
 * are tempo-relative — so a tempo change alone used to move where trimmed
 * audio starts in its recording (the limitation ARCHITECTURE.md carried
 * for years). The trim point is a physical spot in the source and must
 * not move: un-conformed audio clips get `offset` rescaled by
 * newTempo/oldTempo, which keeps `(offset / ticksPerSecond) * rate`
 * — the buffer-seconds trim — exactly invariant. Clips the op CONFORMS
 * are left alone: their `rate` scales with the tempo, which already
 * cancels the tick rescale (the same physical invariance, via stretch).
 * MIDI clips (assetId null) are musical material and correctly follow
 * ticks. Explicit `offsets` entries (undo's exact restoration — derived
 * rescaling rounds to integer ticks, so the reverse derivation may be
 * off by one) override the derivation per clip.
 */
export function setTempoOffsetChanges(
  state: ProjectState,
  op: Extract<Operation, { type: 'project/setTempo' }>
): Array<{ clipId: ClipId; offset: number }> {
  const tempo = clamp(op.tempo, 20, 400)
  if (tempo === state.tempo) return []
  const explicit = new Map<ClipId, number>()
  for (const entry of op.offsets ?? []) {
    if (state.clips[entry.clipId] && Number.isFinite(entry.offset)) {
      explicit.set(entry.clipId, Math.max(0, Math.round(entry.offset)))
    }
  }
  const conformed = new Set((op.conform ?? []).map((entry) => entry.clipId))
  const scale = tempo / state.tempo
  const out: Array<{ clipId: ClipId; offset: number }> = []
  for (const clip of Object.values(state.clips)) {
    const target = explicit.has(clip.id)
      ? explicit.get(clip.id)!
      : clip.assetId !== null && !conformed.has(clip.id) && clip.offset > 0
        ? Math.max(0, Math.round(clip.offset * scale))
        : clip.offset
    if (target !== clip.offset) out.push({ clipId: clip.id, offset: target })
  }
  return out
}

/**
 * Pure reducer: (state, operation) -> state. Never mutates.
 *
 * Operations targeting entities that no longer exist return the state
 * unchanged rather than throwing. In a collaborative session a peer can
 * legitimately send an op for a clip another peer just deleted; dropping
 * the op keeps every peer convergent.
 */
export function apply(state: ProjectState, op: Operation): ProjectState {
  switch (op.type) {
    case 'project/rename':
      if (state.name === op.name) return state
      return { ...state, name: op.name }

    case 'project/setLyrics':
      if (state.lyrics === op.lyrics) return state
      return { ...state, lyrics: op.lyrics }

    case 'project/setTempo': {
      const tempo = clamp(op.tempo, 20, 400)
      let clips = state.clips
      let clipsChanged = false
      // Trim-point preservation first (computed against the PRE-state
      // tempo; see setTempoOffsetChanges) — idempotent on re-delivery
      // because a matching tempo derives no changes.
      for (const entry of setTempoOffsetChanges(state, op)) {
        const clip = clips[entry.clipId]
        if (!clip) continue
        if (!clipsChanged) clips = { ...clips }
        ;(clips as Record<ClipId, Clip>)[entry.clipId] = { ...clip, offset: entry.offset }
        clipsChanged = true
      }
      for (const entry of op.conform ?? []) {
        const clip = clips[entry.clipId]
        if (!clip) continue
        const stretch =
          Math.round(clamp(entry.stretch, MIN_STRETCH, MAX_STRETCH) * 1000) / 1000
        if (clip.stretch === stretch) continue
        if (!clipsChanged) clips = { ...clips }
        ;(clips as Record<ClipId, Clip>)[entry.clipId] = { ...clip, stretch }
        clipsChanged = true
      }
      if (state.tempo === tempo && !clipsChanged) return state
      return { ...state, tempo, clips }
    }

    case 'project/updateSettings': {
      // The patch re-earns its place here: unknown keys dropped, values
      // clamped deterministically — every peer sanitizes identically.
      const settings = mergeSettings(state.settings, sanitizeSettingsPatch(op.patch))
      if (settings === state.settings) return state
      return { ...state, settings }
    }

    case 'project/setTimeSignature': {
      const beats = clampInt(op.timeSignature[0], 1, 32)
      const unit = op.timeSignature[1]
      if (![1, 2, 4, 8, 16, 32].includes(unit)) return state
      if (state.timeSignature[0] === beats && state.timeSignature[1] === unit) return state
      return { ...state, timeSignature: [beats, unit] as const }
    }

    case 'track/create': {
      if (state.tracks[op.track.id]) return state
      // Root first, then descendants in ascending original index — exactly
      // reverses a cascading delete. Indices land correctly because every
      // earlier insertion sits at a lower index.
      const inserts = [
        { track: op.track, index: op.index },
        ...(op.descendants ?? []).filter((d) => !state.tracks[d.track.id])
      ].sort((a, b) => a.index - b.index)
      const trackOrder = [...state.trackOrder]
      const tracks = { ...state.tracks }
      for (const { track, index } of inserts) {
        trackOrder.splice(clamp(index, 0, trackOrder.length), 0, track.id)
        tracks[track.id] = track
      }
      // A parent that doesn't exist (concurrent folder delete) degrades to root.
      for (const { track } of inserts) {
        if (track.parentId !== null && !tracks[track.parentId]) {
          tracks[track.id] = { ...track, parentId: null }
        }
      }
      const clips = { ...state.clips }
      for (const clip of op.clips) {
        if (tracks[clip.trackId]) clips[clip.id] = clip
      }
      const automation = { ...state.automation }
      for (const point of op.automation) automation[point.id] = point
      const { notes } = withNotes(state.notes, clips, op.notes)
      const plugins = { ...state.plugins }
      for (const instance of op.plugins) {
        if (!plugins[instance.id]) plugins[instance.id] = instance
      }
      let next: ProjectState = { ...state, tracks, trackOrder, clips, automation, notes, plugins }
      // Restore the subtree's routing edges (validated like any other add).
      if (op.routes && op.routes.length > 0) {
        next = apply(next, { type: 'route/addMany', routes: op.routes })
      }
      return next
    }

    case 'track/delete': {
      if (!state.tracks[op.trackId]) return state
      // Folders cascade: deleting a folder removes its whole subtree.
      const doomed = new Set(
        state.trackOrder.filter((id) => isTrackSelfOrDescendant(state, id, op.trackId))
      )
      const tracks: Record<TrackId, Track> = {}
      for (const track of Object.values(state.tracks)) {
        if (!doomed.has(track.id)) tracks[track.id] = track
      }
      const clips: Record<ClipId, Clip> = {}
      for (const clip of Object.values(state.clips)) {
        if (!doomed.has(clip.trackId)) clips[clip.id] = clip
      }
      const automation: Record<string, AutomationPoint> = {}
      for (const point of Object.values(state.automation)) {
        if (!doomed.has(point.trackId)) automation[point.id] = point
      }
      const notes: Record<string, Note> = {}
      for (const note of Object.values(state.notes)) {
        if (clips[note.clipId]) notes[note.id] = note
      }
      const plugins: Record<string, PluginInstance> = {}
      for (const instance of Object.values(state.plugins)) {
        if (!doomed.has(instance.trackId)) plugins[instance.id] = instance
      }
      const routes: Record<string, Route> = {}
      for (const route of Object.values(state.routes)) {
        if (!doomed.has(route.trackId)) routes[route.id] = route
      }
      return {
        ...state,
        tracks,
        trackOrder: state.trackOrder.filter((id) => !doomed.has(id)),
        clips,
        automation,
        notes,
        plugins,
        routes
      }
    }

    case 'track/setParent': {
      const track = state.tracks[op.trackId]
      if (!track || track.parentId === op.parentId) return state
      if (op.parentId !== null) {
        const parent = state.tracks[op.parentId]
        if (!parent || parent.kind !== 'folder') return state
        // A folder can never be moved into itself or its own subtree.
        if (isTrackSelfOrDescendant(state, op.parentId, op.trackId)) return state
      }
      return {
        ...state,
        tracks: { ...state.tracks, [op.trackId]: { ...track, parentId: op.parentId } }
      }
    }

    case 'track/freeze': {
      const track = state.tracks[op.trackId]
      if (!track || track.kind === 'folder' || track.frozenAssetId === op.assetId) return state
      return {
        ...state,
        tracks: { ...state.tracks, [op.trackId]: { ...track, frozenAssetId: op.assetId } }
      }
    }

    case 'track/unfreeze': {
      const track = state.tracks[op.trackId]
      if (!track || track.frozenAssetId === null) return state
      return {
        ...state,
        tracks: { ...state.tracks, [op.trackId]: { ...track, frozenAssetId: null } }
      }
    }

    case 'track/setVolume':
      return updateTrack(state, op.trackId, (t) => ({
        ...t,
        volume: clamp(op.volume, 0, MAX_GAIN)
      }))

    case 'track/setPan':
      return updateTrack(state, op.trackId, (t) => ({ ...t, pan: clamp(op.pan, -1, 1) }))

    case 'project/setMasterVolume': {
      const volume = clamp(op.volume, 0, MAX_GAIN)
      if (state.masterVolume === volume) return state
      return { ...state, masterVolume: volume }
    }

    case 'automation/add': {
      if (state.automation[op.point.id]) return state
      if (!state.tracks[op.point.trackId]) return state
      // Plugin-param points must name a live insert on the same track (and
      // one of its known params); track points are volume/pan only.
      if (op.point.instanceId !== undefined) {
        const instance = state.plugins[op.point.instanceId]
        if (!instance || instance.trackId !== op.point.trackId) return state
        const defs = paramDefsOf(instance.descriptor)
        if (defs && !defs[op.point.param]) return state
      } else if (op.point.param !== 'volume' && op.point.param !== 'pan') {
        return state
      }
      const point = {
        ...op.point,
        ticks: Math.max(0, op.point.ticks),
        value: clamp(op.point.value, 0, 1)
      }
      return { ...state, automation: { ...state.automation, [point.id]: point } }
    }

    case 'automation/move': {
      const point = state.automation[op.pointId]
      if (!point) return state
      const ticks = Math.max(0, op.ticks)
      const value = clamp(op.value, 0, 1)
      if (point.ticks === ticks && point.value === value) return state
      return {
        ...state,
        automation: { ...state.automation, [op.pointId]: { ...point, ticks, value } }
      }
    }

    case 'automation/delete': {
      if (!state.automation[op.pointId]) return state
      const automation = { ...state.automation }
      delete automation[op.pointId]
      return { ...state, automation }
    }

    case 'note/add': {
      const { notes, changed } = withNotes(state.notes, state.clips, [op.note])
      return changed ? { ...state, notes } : state
    }

    case 'note/addMany': {
      const { notes, changed } = withNotes(state.notes, state.clips, op.notes)
      return changed ? { ...state, notes } : state
    }

    case 'note/move': {
      const note = state.notes[op.noteId]
      if (!note) return state
      const pitch = clampInt(op.pitch, 0, 127)
      const start = Math.max(0, op.start)
      if (note.pitch === pitch && note.start === start) return state
      return { ...state, notes: { ...state.notes, [op.noteId]: { ...note, pitch, start } } }
    }

    case 'note/moveMany': {
      let next = state
      for (const move of op.moves) next = apply(next, { type: 'note/move', ...move })
      return next
    }

    case 'note/resize': {
      const note = state.notes[op.noteId]
      if (!note) return state
      const duration = Math.max(1, op.duration)
      const start = op.start !== undefined ? Math.max(0, op.start) : note.start
      if (note.duration === duration && note.start === start) return state
      return { ...state, notes: { ...state.notes, [op.noteId]: { ...note, duration, start } } }
    }

    case 'note/setVelocity': {
      const note = state.notes[op.noteId]
      if (!note) return state
      const velocity = clampInt(op.velocity, 1, 127)
      if (note.velocity === velocity) return state
      return { ...state, notes: { ...state.notes, [op.noteId]: { ...note, velocity } } }
    }

    case 'note/delete': {
      const doomed = new Set(op.noteIds)
      let changed = false
      const notes: Record<string, Note> = {}
      for (const note of Object.values(state.notes)) {
        if (doomed.has(note.id)) changed = true
        else notes[note.id] = note
      }
      return changed ? { ...state, notes } : state
    }

    case 'plugin/add': {
      if (state.plugins[op.instance.id]) return state
      // The master bus accepts inserts without being a track (MASTER_BUS_ID).
      if (op.instance.trackId !== MASTER_BUS_ID && !state.tracks[op.instance.trackId]) return state
      const defs = paramDefsOf(op.instance.descriptor)
      // A builtin descriptor whose uid core doesn't know is unusable.
      if (op.instance.descriptor.format === 'builtin' && !defs) return state
      const params = sanitizeParams(defs, op.instance.params)
      let next: ProjectState = {
        ...state,
        plugins: { ...state.plugins, [op.instance.id]: { ...op.instance, params } }
      }
      // Splicing into a live graph: the edges the node now sits on go
      // first, so the replacement wiring below can't collide with them.
      if (op.severedRoutes && op.severedRoutes.length > 0) {
        next = apply(next, {
          type: 'route/deleteMany',
          routeIds: op.severedRoutes.map((r) => r.id)
        })
      }
      // Undoing a remove puts the node's graph connections back (each edge
      // re-validated — a concurrently deleted neighbor just drops its edge).
      if (op.routes && op.routes.length > 0) {
        next = apply(next, { type: 'route/addMany', routes: op.routes })
      }
      // ...and its parameter automation (each point re-validated).
      for (const point of op.automation ?? []) {
        next = apply(next, { type: 'automation/add', point })
      }
      return next
    }

    case 'plugin/remove': {
      if (!state.plugins[op.instanceId]) return state
      const plugins = { ...state.plugins }
      delete plugins[op.instanceId]
      // Cascade: a routing edge without both endpoints is meaningless, and
      // so is automation of a parameter that no longer exists.
      const routes: Record<string, Route> = {}
      for (const route of Object.values(state.routes)) {
        if (route.from !== op.instanceId && route.to !== op.instanceId) routes[route.id] = route
      }
      let automation = state.automation
      if (Object.values(state.automation).some((p) => p.instanceId === op.instanceId)) {
        automation = {}
        for (const point of Object.values(state.automation)) {
          if (point.instanceId !== op.instanceId) {
            (automation as Record<string, AutomationPoint>)[point.id] = point
          }
        }
      }
      let next: ProjectState = { ...state, plugins, routes, automation }
      // Undoing a spliced-in add: heal the edges that add severed (each
      // re-validated against what actually remains).
      if (op.restoreRoutes && op.restoreRoutes.length > 0) {
        next = apply(next, { type: 'route/addMany', routes: op.restoreRoutes })
      }
      return next
    }

    case 'route/addMany': {
      let changed = false
      let next = state
      for (const route of op.routes) {
        // Validated against the EVOLVING state so edges within one op can
        // build on each other, and invalid ones drop individually.
        if (!routeIsValid(next, route)) continue
        next = { ...next, routes: { ...next.routes, [route.id]: route } }
        changed = true
      }
      return changed ? next : state
    }

    case 'route/deleteMany': {
      const doomed = new Set(op.routeIds)
      let changed = false
      const routes: Record<string, Route> = {}
      for (const route of Object.values(state.routes)) {
        if (doomed.has(route.id)) changed = true
        else routes[route.id] = route
      }
      return changed ? { ...state, routes } : state
    }

    case 'plugin/setGraphPos': {
      const instance = state.plugins[op.instanceId]
      if (!instance || !Number.isFinite(op.x) || !Number.isFinite(op.y)) return state
      const x = Math.round(clamp(op.x, 0, 8000))
      const y = Math.round(clamp(op.y, 0, 8000))
      if (instance.graphX === x && instance.graphY === y) return state
      return {
        ...state,
        plugins: { ...state.plugins, [op.instanceId]: { ...instance, graphX: x, graphY: y } }
      }
    }

    case 'track/setGraphTerminal': {
      const track = state.tracks[op.trackId]
      if (!track || !Number.isFinite(op.x) || !Number.isFinite(op.y)) return state
      const x = Math.round(clamp(op.x, 0, 8000))
      const y = Math.round(clamp(op.y, 0, 8000))
      const patch =
        op.terminal === 'in' ? { graphInX: x, graphInY: y } : { graphOutX: x, graphOutY: y }
      const same =
        op.terminal === 'in'
          ? track.graphInX === x && track.graphInY === y
          : track.graphOutX === x && track.graphOutY === y
      if (same) return state
      return {
        ...state,
        tracks: { ...state.tracks, [op.trackId]: { ...track, ...patch } }
      }
    }

    case 'plugin/setParam': {
      const instance = state.plugins[op.instanceId]
      if (!instance || !Number.isFinite(op.value)) return state
      const defs = paramDefsOf(instance.descriptor)
      const def = defs?.[op.param]
      if (defs && !def) return state
      const value = def ? clampParam(def, op.value) : op.value
      if (instance.params[op.param] === value) return state
      return {
        ...state,
        plugins: {
          ...state.plugins,
          [op.instanceId]: { ...instance, params: { ...instance.params, [op.param]: value } }
        }
      }
    }

    case 'plugin/setParams': {
      const instance = state.plugins[op.instanceId]
      if (!instance) return state
      const defs = paramDefsOf(instance.descriptor)
      let changed = false
      const params = { ...instance.params }
      for (const [key, raw] of Object.entries(op.params)) {
        if (!Number.isFinite(raw)) continue
        const def = defs?.[key]
        // With known defs, unknown keys are dropped (mirrors plugin/setParam).
        if (defs && !def) continue
        const value = def ? clampParam(def, raw) : raw
        if (params[key] === value) continue
        params[key] = value
        changed = true
      }
      if (!changed) return state
      return {
        ...state,
        plugins: { ...state.plugins, [op.instanceId]: { ...instance, params } }
      }
    }

    case 'plugin/setEnabled': {
      const instance = state.plugins[op.instanceId]
      if (!instance || instance.enabled === op.enabled) return state
      return {
        ...state,
        plugins: { ...state.plugins, [op.instanceId]: { ...instance, enabled: op.enabled } }
      }
    }

    case 'plugin/reorder': {
      if (op.trackId !== MASTER_BUS_ID && !state.tracks[op.trackId]) return state
      const chain = pluginsOfTrack(state, op.trackId)
      const byId = new Map(chain.map((p) => [p.id, p]))
      const ordered: PluginInstance[] = []
      const placed = new Set<string>()
      for (const id of op.order) {
        const instance = byId.get(id)
        if (!instance || placed.has(id)) continue
        placed.add(id)
        ordered.push(instance)
      }
      // Inserts a peer added concurrently aren't in `order` — keep them.
      for (const instance of chain) if (!placed.has(instance.id)) ordered.push(instance)

      // Permute the chain's EXISTING rank values rather than renumbering
      // from zero: the rank set is preserved, so re-applying the previous
      // order restores the previous state exactly (a clean invert).
      const ranks = chain.map((p) => p.rank).sort((a, b) => a - b)
      let changed = false
      const plugins = { ...state.plugins }
      ordered.forEach((instance, index) => {
        const rank = ranks[index]
        if (instance.rank === rank) return
        plugins[instance.id] = { ...instance, rank }
        changed = true
      })
      return changed ? { ...state, plugins } : state
    }

    case 'plugin/setState': {
      const instance = state.plugins[op.instanceId]
      if (!instance || instance.stateBlob === op.stateBlob) return state
      return {
        ...state,
        plugins: {
          ...state.plugins,
          [op.instanceId]: { ...instance, stateBlob: op.stateBlob }
        }
      }
    }

    case 'plugin/setSidechain': {
      const instance = state.plugins[op.instanceId]
      if (!instance) return state
      // A key must reference a live track, and never the insert's own
      // track (a self-key is a guaranteed feedback cycle). Ancestor buses
      // can only be checked dynamically — reparenting after the fact can
      // create that cycle — so the ENGINE guards those at wire time.
      if (op.trackId !== null && (!state.tracks[op.trackId] || op.trackId === instance.trackId)) {
        return state
      }
      if ((instance.sidechainTrackId ?? null) === op.trackId) return state
      // Clearing REMOVES the field (never stores an explicit null): a
      // set-then-clear round-trips to the exact original instance, and
      // documents never accrete null keys.
      const { sidechainTrackId: _prev, ...rest } = instance
      return {
        ...state,
        plugins: {
          ...state.plugins,
          [op.instanceId]: op.trackId === null ? rest : { ...instance, sidechainTrackId: op.trackId }
        }
      }
    }

    case 'track/setSynthParam': {
      const track = state.tracks[op.trackId]
      if (!track || !isNoteTrackKind(track.kind)) return state
      const def = SYNTH_DEFS[op.param]
      if (!def) return state
      const value = clampParam(def, op.value)
      if (track.synth[op.param] === value) return state
      return {
        ...state,
        tracks: {
          ...state.tracks,
          [op.trackId]: { ...track, synth: { ...track.synth, [op.param]: value } }
        }
      }
    }

    case 'track/setSynthParams': {
      const track = state.tracks[op.trackId]
      if (!track || !isNoteTrackKind(track.kind)) return state
      let changed = false
      const synth = { ...track.synth }
      for (const [param, raw] of Object.entries(op.params)) {
        const def = SYNTH_DEFS[param]
        if (!def) continue
        const value = clampParam(def, raw)
        if (synth[param] === value) continue
        synth[param] = value
        changed = true
      }
      if (!changed) return state
      return { ...state, tracks: { ...state.tracks, [op.trackId]: { ...track, synth } } }
    }

    case 'track/setSampler': {
      const track = state.tracks[op.trackId]
      if (!track || !isNoteTrackKind(track.kind)) return state
      const assetId = typeof op.assetId === 'string' ? op.assetId : null
      let changed = (track.samplerAssetId ?? null) !== assetId
      const synth = { ...track.synth }
      for (const [param, raw] of Object.entries(op.params ?? {})) {
        const def = SYNTH_DEFS[param]
        if (!def) continue
        const value = clampParam(def, raw)
        if (synth[param] === value) continue
        synth[param] = value
        changed = true
      }
      if (!changed) return state
      return {
        ...state,
        tracks: {
          ...state.tracks,
          [op.trackId]: { ...track, samplerAssetId: assetId, synth }
        }
      }
    }

    case 'pad/set': {
      const pad = sanitizePad(op.pad)
      if (!pad) return state
      const existing = state.pads[pad.id]
      if (existing && padsEqual(existing, pad)) return state
      return { ...state, pads: { ...state.pads, [pad.id]: pad } }
    }

    case 'pad/clear': {
      if (!state.pads[op.padId]) return state
      const pads = { ...state.pads }
      delete pads[op.padId]
      return { ...state, pads }
    }

    case 'marker/create': {
      const marker = sanitizeMarker(op.marker)
      // An existing id means re-delivery — never a second write, so a
      // concurrent marker/update can't be clobbered by a replayed create.
      if (!marker || state.markers[marker.id]) return state
      return { ...state, markers: { ...state.markers, [marker.id]: marker } }
    }

    case 'marker/delete': {
      if (!state.markers[op.markerId]) return state
      const markers = { ...state.markers }
      delete markers[op.markerId]
      return { ...state, markers }
    }

    case 'marker/update': {
      const marker = state.markers[op.markerId]
      if (!marker) return state // convergence: target vanished, drop it
      // Each touched field re-earns its place through the same sanitizer
      // create uses; untouched fields keep the marker's current values.
      const next = sanitizeMarker({
        ...marker,
        ...(op.name !== undefined ? { name: op.name } : {}),
        ...(op.ticks !== undefined ? { ticks: op.ticks } : {}),
        ...(op.color !== undefined ? { color: op.color } : {})
      })
      if (!next || markersEqual(marker, next)) return state
      return { ...state, markers: { ...state.markers, [op.markerId]: next } }
    }

    case 'macro/setValue': {
      const track = state.tracks[op.trackId]
      if (!track) return state
      if (!Number.isInteger(op.index) || op.index < 0 || op.index >= MAX_MACROS) return state
      if (!Number.isFinite(op.value)) return state
      const value = clamp(op.value, 0, 1)
      const macros = materializeMacros(track.macros, op.index)
      macros[op.index] = { ...macros[op.index], value }
      let next = withTrackMacros(state, op.trackId, canonicalMacros(macros))
      // The carried DERIVED values (computed by buildMacroSetValue before
      // dispatch) apply absolutely through the plugin/setParam path — same
      // clamp, same unknown-param drop, and entries whose instance is gone
      // skip individually, so re-delivery is idempotent and peers converge.
      for (const entry of op.params) {
        next = apply(next, {
          type: 'plugin/setParam',
          instanceId: entry.instanceId,
          param: entry.param,
          value: entry.value
        })
      }
      return next
    }

    case 'macro/configure': {
      const track = state.tracks[op.trackId]
      if (!track) return state
      if (!Number.isInteger(op.index) || op.index < 0 || op.index >= MAX_MACROS) return state
      const macros = materializeMacros(track.macros, op.index)
      let slot = macros[op.index]
      if (typeof op.name === 'string' && op.name !== '') slot = { ...slot, name: op.name }
      if (Array.isArray(op.targets)) {
        // Each target re-earns its place (live instance ON this track,
        // known param, finite range); invalid or duplicate ones drop
        // individually so the rest of the retarget still lands.
        const targets: MacroTarget[] = []
        for (const raw of op.targets) {
          const target = sanitizeMacroTarget(raw, op.trackId, state.plugins)
          if (!target) continue
          if (targets.some((t) => t.instanceId === target.instanceId && t.param === target.param)) {
            continue
          }
          targets.push(target)
        }
        slot = { ...slot, targets }
      }
      macros[op.index] = slot
      return withTrackMacros(state, op.trackId, canonicalMacros(macros))
    }

    case 'track/rename':
      return updateTrack(state, op.trackId, (t) => ({ ...t, name: op.name }))

    case 'track/setMute':
      return updateTrack(state, op.trackId, (t) => ({ ...t, muted: op.muted }))

    case 'track/setSolo':
      return updateTrack(state, op.trackId, (t) => ({ ...t, soloed: op.soloed }))

    case 'track/reorder': {
      const from = state.trackOrder.indexOf(op.trackId)
      if (from === -1) return state
      const trackOrder = [...state.trackOrder]
      trackOrder.splice(from, 1)
      trackOrder.splice(clamp(op.index, 0, trackOrder.length), 0, op.trackId)
      let next: ProjectState = { ...state, trackOrder }
      // Optional atomic re-parent (drag into/out of a folder = one op).
      if (op.parentId !== undefined) {
        next = apply(next, { type: 'track/setParent', trackId: op.trackId, parentId: op.parentId })
      }
      return next
    }

    case 'track/group': {
      if (state.tracks[op.folder.id]) return state
      if (op.folder.kind !== 'folder') return state
      // Nothing to wrap = nothing to do; a lone folder is `track/create`.
      const members = op.trackIds.filter(
        (id) => state.tracks[id] && !isTrackSelfOrDescendant(state, id, op.folder.id)
      )
      if (members.length === 0) return state
      const folder: Track = { ...op.folder, parentId: op.folder.parentId ?? null }
      // Pull the members out, drop the folder in, then re-insert them
      // directly after it so the folder visually contains its children.
      const rest = state.trackOrder.filter((id) => !members.includes(id))
      const at = clamp(op.index, 0, rest.length)
      const trackOrder = [...rest.slice(0, at), folder.id, ...members, ...rest.slice(at)]
      const tracks = { ...state.tracks, [folder.id]: folder }
      for (const id of members) tracks[id] = { ...tracks[id], parentId: folder.id }
      return { ...state, tracks, trackOrder }
    }

    case 'track/ungroup': {
      const folder = state.tracks[op.folderId]
      if (!folder || folder.kind !== 'folder') return state
      const tracks = { ...state.tracks }
      delete tracks[op.folderId]
      const previous = new Map(op.restore.map((r) => [r.trackId, r]))
      // Children the op doesn't mention (a peer added them concurrently)
      // inherit the folder's own parent rather than being orphaned.
      for (const track of Object.values(state.tracks)) {
        if (track.parentId !== op.folderId) continue
        tracks[track.id] = {
          ...track,
          parentId: previous.get(track.id)?.parentId ?? folder.parentId
        }
      }
      // Rebuild the order without the folder, then place restored tracks at
      // their recorded indices (ascending, so earlier ones don't shift later).
      let trackOrder = state.trackOrder.filter(
        (id) => id !== op.folderId && !previous.has(id)
      )
      for (const entry of [...op.restore].sort((a, b) => a.index - b.index)) {
        if (!tracks[entry.trackId]) continue
        trackOrder = [
          ...trackOrder.slice(0, clamp(entry.index, 0, trackOrder.length)),
          entry.trackId,
          ...trackOrder.slice(clamp(entry.index, 0, trackOrder.length))
        ]
      }
      return { ...state, tracks, trackOrder }
    }

    case 'clip/create': {
      if (state.clips[op.clip.id]) return state
      const track = state.tracks[op.clip.trackId]
      if (!track || track.kind === 'folder') return state // folders hold tracks, not clips
      const clips = { ...state.clips, [op.clip.id]: op.clip }
      const { notes } = withNotes(state.notes, clips, op.notes)
      return { ...state, clips, notes }
    }

    case 'clip/delete': {
      if (!state.clips[op.clipId]) return state
      const clips = { ...state.clips }
      delete clips[op.clipId]
      const notes: Record<string, Note> = {}
      for (const note of Object.values(state.notes)) {
        if (note.clipId !== op.clipId) notes[note.id] = note
      }
      return { ...state, clips, notes }
    }

    case 'clip/move': {
      const target = state.tracks[op.trackId]
      if (!target || target.kind === 'folder') return state
      return updateClip(state, op.clipId, (c) => ({
        ...c,
        trackId: op.trackId,
        start: Math.max(0, op.start)
      }))
    }

    case 'clip/resize':
      return updateClip(state, op.clipId, (c) => ({
        ...c,
        start: Math.max(0, op.start),
        duration: Math.max(1, op.duration),
        offset: Math.max(0, op.offset),
        loopLength: op.loopLength !== undefined ? normalizeLoop(op.loopLength) : c.loopLength,
        // Same clamp/rounding as clip/setPlayback, so the two ops agree.
        stretch:
          op.stretch !== undefined && Number.isFinite(op.stretch)
            ? Math.min(MAX_STRETCH, Math.max(MIN_STRETCH, Math.round(op.stretch * 1000) / 1000))
            : c.stretch
      }))

    case 'clip/resizeWithNotes': {
      const clip = state.clips[op.clipId]
      if (!clip) return state
      const duration = Math.max(1, Math.round(op.duration))
      let clips: Readonly<Record<ClipId, Clip>> = state.clips
      let next: Record<ClipId, Clip> | null = null
      const edit = (): Record<ClipId, Clip> => {
        if (!next) clips = next = { ...state.clips }
        return next
      }
      if (duration !== clip.duration) edit()[op.clipId] = { ...clip, duration }
      // Stamps of this loop grow with it, so a loop taken from one bar to
      // two does not leave its copies playing half of it.
      for (const follower of op.followers ?? []) {
        const target = clips[follower.clipId]
        if (!target) continue
        const followerDuration = Math.max(1, Math.round(follower.duration))
        if (target.duration === followerDuration) continue
        edit()[follower.clipId] = { ...target, duration: followerDuration }
      }
      // Removals first: the invert deletes the notes the forward op added,
      // and an id could otherwise be removed and re-added in one pass.
      let notes: Readonly<Record<string, Note>> = state.notes
      if (op.removeNoteIds && op.removeNoteIds.length > 0) {
        const next = { ...notes }
        for (const id of op.removeNoteIds) delete next[id]
        notes = next
      }
      const added = withNotes(notes, clips, op.notes)
      if (clips === state.clips && notes === state.notes && !added.changed) return state
      return { ...state, clips, notes: added.notes }
    }

    case 'clip/deleteMany': {
      let next = state
      for (const clipId of op.clipIds) next = apply(next, { type: 'clip/delete', clipId })
      return next
    }

    case 'clip/createMany': {
      let next = state
      for (const clip of op.clips) {
        next = apply(next, {
          type: 'clip/create',
          clip,
          notes: op.notes.filter((n) => n.clipId === clip.id)
        })
      }
      return next
    }

    case 'clip/moveMany': {
      let next = state
      for (const move of op.moves) next = apply(next, { type: 'clip/move', ...move })
      return next
    }

    case 'clip/resizeMany': {
      let next = state
      for (const edit of op.edits) next = apply(next, { type: 'clip/resize', ...edit })
      return next
    }

    case 'clip/restore': {
      const current = state.clips[op.clipId]
      if (!current) return state
      const src = op.clip
      const duration = Math.max(1, Math.round(src.duration))
      const fadeIn = Math.min(Math.max(0, Math.round(src.fadeIn)), duration)
      const restored: Clip = {
        ...current,
        // The stored home track is honored only while it still exists.
        trackId: state.tracks[src.trackId] ? src.trackId : current.trackId,
        name: typeof src.name === 'string' && src.name !== '' ? src.name : current.name,
        start: Math.max(0, Math.round(src.start)),
        duration,
        // The material itself is the clip's identity, not its history.
        assetId: current.assetId,
        offset: Math.max(0, Math.round(src.offset)),
        color: typeof src.color === 'string' ? src.color : null,
        fadeIn,
        fadeOut: Math.min(Math.max(0, Math.round(src.fadeOut)), duration - fadeIn),
        reverse: src.reverse === true,
        pitch: clamp(src.pitch, MIN_PITCH, MAX_PITCH),
        stretch: Math.round(clamp(src.stretch, MIN_STRETCH, MAX_STRETCH) * 1000) / 1000,
        loopLength: normalizeLoop(src.loopLength)
      }
      const same = (Object.keys(restored) as Array<keyof Clip>).every(
        (key) => restored[key] === current[key]
      )
      if (same) return state
      return { ...state, clips: { ...state.clips, [op.clipId]: restored } }
    }

    case 'track/restore': {
      const track = state.tracks[op.trackId]
      if (!track) return state
      const synth: Record<string, number> = {}
      for (const [key, value] of Object.entries(op.track.synth ?? {})) {
        if (!Number.isFinite(value)) continue
        synth[key] = SYNTH_DEFS[key] ? clampParam(SYNTH_DEFS[key], value) : value
      }
      const restored: Track = {
        ...track,
        name: typeof op.track.name === 'string' && op.track.name !== '' ? op.track.name : track.name,
        color: typeof op.track.color === 'string' ? op.track.color : track.color,
        muted: op.track.muted === true,
        soloed: op.track.soloed === true,
        volume: clamp(op.track.volume, 0, MAX_GAIN),
        pan: clamp(op.track.pan, -1, 1),
        synth: isNoteTrackKind(track.kind) ? synth : track.synth
      }
      const sameSynth =
        Object.keys(restored.synth).length === Object.keys(track.synth).length &&
        Object.entries(restored.synth).every(([k, v]) => track.synth[k] === v)
      const same =
        sameSynth &&
        restored.name === track.name &&
        restored.color === track.color &&
        restored.muted === track.muted &&
        restored.soloed === track.soloed &&
        restored.volume === track.volume &&
        restored.pan === track.pan
      if (same) return state
      return { ...state, tracks: { ...state.tracks, [op.trackId]: restored } }
    }

    case 'plugin/restore': {
      const instance = state.plugins[op.instanceId]
      if (!instance) return state
      const defs = paramDefsOf(instance.descriptor)
      const params = sanitizeParams(defs, op.params)
      const enabled = op.enabled === true
      const stateBlob = typeof op.stateBlob === 'string' ? op.stateBlob : null
      const sameParams =
        Object.keys(params).length === Object.keys(instance.params).length &&
        Object.entries(params).every(([k, v]) => instance.params[k] === v)
      if (sameParams && instance.enabled === enabled && instance.stateBlob === stateBlob) {
        return state
      }
      return {
        ...state,
        plugins: {
          ...state.plugins,
          [op.instanceId]: { ...instance, params, enabled, stateBlob }
        }
      }
    }

    case 'clip/rename':
      return updateClip(state, op.clipId, (c) => ({ ...c, name: op.name }))

    case 'clip/setColor':
      return updateClip(state, op.clipId, (c) =>
        c.color === op.color ? c : { ...c, color: op.color }
      )

    case 'clip/setPlayback':
      return updateClip(state, op.clipId, (c) => {
        const pitch = Number.isFinite(op.pitch)
          ? Math.min(MAX_PITCH, Math.max(MIN_PITCH, Math.round(op.pitch * 100) / 100))
          : c.pitch
        const stretch = Number.isFinite(op.stretch)
          ? Math.min(MAX_STRETCH, Math.max(MIN_STRETCH, Math.round(op.stretch * 1000) / 1000))
          : c.stretch
        const warp = typeof op.warp === 'boolean' ? op.warp : (c.warp ?? false)
        if (
          c.reverse === op.reverse &&
          c.pitch === pitch &&
          c.stretch === stretch &&
          (c.warp ?? false) === warp
        ) {
          return c
        }
        // Canonical form: warp false = the field is ABSENT, so toggling it
        // off round-trips to a clip identical to one that never warped.
        const { warp: _dropped, ...rest } = c
        return { ...rest, reverse: op.reverse, pitch, stretch, ...(warp ? { warp: true } : {}) }
      })

    case 'clip/setFades':
      return updateClip(state, op.clipId, (c) => {
        // Fades can never overlap: cap each at the duration, then shrink
        // the fade-out first if they still collide (deterministic).
        const fadeIn = clampInt(op.fadeIn, 0, c.duration)
        const fadeOut = clampInt(op.fadeOut, 0, c.duration - fadeIn)
        return c.fadeIn === fadeIn && c.fadeOut === fadeOut ? c : { ...c, fadeIn, fadeOut }
      })

    case 'clip/split': {
      const clip = state.clips[op.clipId]
      if (!clip) return state
      if (state.clips[op.rightClipId]) return state // already split (idempotency)
      const at = Math.round(op.at)
      if (at <= clip.start || at >= clip.start + clip.duration) return state
      const splitOffset = at - clip.start
      const leftDuration = clamp(op.leftDuration ?? splitOffset, 1, splitOffset)
      const right: Clip = {
        id: op.rightClipId,
        trackId: clip.trackId,
        name: op.rightName ?? clip.name,
        start: at,
        duration: clip.start + clip.duration - at,
        assetId: clip.assetId,
        // Audio keeps playing the same source material across the cut; in a
        // looped clip the cut may land mid-repeat, so take the offset within
        // the pattern rather than from the clip's start.
        offset:
          clip.assetId !== null
            ? clip.offset + (isClipLooped(clip) ? splitOffset % clip.loopLength : splitOffset)
            : 0,
        color: op.rightColor !== undefined ? op.rightColor : clip.color,
        // The original fade-out travels with the clip's end (the right half).
        fadeIn: op.rightFades ? op.rightFades[0] : 0,
        fadeOut: op.rightFades ? op.rightFades[1] : clip.fadeOut,
        // Both halves keep playing the same way (reversed/transposed/scaled).
        reverse: clip.reverse,
        pitch: clip.pitch,
        stretch: clip.stretch,
        // A looped clip's halves keep the period; the right half starts at
        // its position WITHIN the pattern so audio is continuous at the cut
        // (its later repeats then cycle from that point, not the original
        // phase — the price of not storing a separate loop-phase field).
        loopLength: clip.loopLength,
        // Cutting a stamp yields two stamps of the same loop: neither half
        // owns notes, so both keep following the source.
        ...(clip.sourceClipId ? { sourceClipId: clip.sourceClipId } : {}),
        ...(clip.freeLength ? { freeLength: true } : {})
      }
      const clips = {
        ...state.clips,
        [clip.id]: { ...clip, duration: leftDuration, fadeOut: op.leftFadeOut ?? 0 },
        [right.id]: right
      }
      // Notes at/after the cut move to the right clip, re-based to its
      // start. A stamp owns none, so this is a no-op for one.
      let notes = state.notes
      let notesChanged = false
      const nextNotes: Record<string, Note> = { ...state.notes }
      for (const note of Object.values(state.notes)) {
        if (note.clipId !== clip.id || note.start < splitOffset) continue
        nextNotes[note.id] = { ...note, clipId: right.id, start: note.start - splitOffset }
        notesChanged = true
      }
      if (notesChanged) notes = nextNotes
      return { ...state, clips, notes }
    }

    case 'clip/slice': {
      let next = state
      for (const slice of op.slices) {
        // Each cut lands in the piece the PREVIOUS cut produced, so the
        // positions stay absolute and independent of one another.
        let target = slice.clipId
        const cuts = slice.at.map((a) => Math.round(a)).sort((a, b) => a - b)
        cuts.forEach((at, i) => {
          const rightClipId = slice.newClipIds[i]
          if (!rightClipId) return
          next = apply(next, { type: 'clip/split', clipId: target, at, rightClipId })
          // Missing = that cut fell outside the clip; keep cutting the same
          // target so later positions still apply.
          if (next.clips[rightClipId]) target = rightClipId
        })
      }
      return next
    }

    case 'clip/unslice': {
      let next = state
      for (const merge of op.merges) {
        for (const pieceId of merge.pieceIds) {
          next = apply(next, { type: 'clip/merge', clipId: merge.clipId, rightClipId: pieceId })
        }
      }
      return next
    }

    case 'clip/merge': {
      const left = state.clips[op.clipId]
      const right = state.clips[op.rightClipId]
      if (!left || !right || left.trackId !== right.trackId) return state
      if (right.start < left.start) return state
      const duration = Math.max(left.duration, right.start + right.duration - left.start)
      // The merged clip's end is the right clip's end: its fade-out wins.
      const clips = { ...state.clips, [left.id]: { ...left, duration, fadeOut: right.fadeOut } }
      delete clips[right.id]
      const shift = right.start - left.start
      let notes = state.notes
      let notesChanged = false
      const nextNotes: Record<string, Note> = { ...state.notes }
      for (const note of Object.values(state.notes)) {
        if (note.clipId !== right.id) continue
        nextNotes[note.id] = { ...note, clipId: left.id, start: note.start + shift }
        notesChanged = true
      }
      if (notesChanged) notes = nextNotes
      return { ...state, clips, notes }
    }

    case 'file/create': {
      const files = { ...state.files }
      let changed = false
      for (const node of op.nodes) {
        if (files[node.id]) continue
        // A node's parent must exist (or be root) and be a folder.
        if (node.parentId !== null) {
          const parent = files[node.parentId]
          if (!parent || parent.kind !== 'folder') continue
        }
        files[node.id] = node
        changed = true
      }
      return changed ? { ...state, files } : state
    }

    case 'file/delete': {
      const doomed = new Set<string>()
      for (const nodeId of op.nodeIds) {
        for (const node of subtreeOf(state, nodeId)) doomed.add(node.id)
      }
      if (doomed.size === 0) return state
      const files: Record<string, FileNode> = {}
      for (const node of Object.values(state.files)) {
        if (!doomed.has(node.id)) files[node.id] = node
      }
      return { ...state, files }
    }

    case 'file/rename': {
      const node = state.files[op.nodeId]
      if (!node || node.name === op.name) return state
      return { ...state, files: { ...state.files, [op.nodeId]: { ...node, name: op.name } } }
    }

    case 'chat/post': {
      if (state.chat.some((m) => m.id === op.message.id)) return state
      return { ...state, chat: [...state.chat, op.message] }
    }

    case 'comment/add': {
      const comments = { ...state.comments }
      let changed = false
      for (const comment of op.comments) {
        if (comments[comment.id]) continue
        // A reply's root must exist (deleted-thread replies are dropped).
        if (comment.parentId !== null && !comments[comment.parentId]) continue
        comments[comment.id] = comment
        changed = true
      }
      return changed ? { ...state, comments } : state
    }

    case 'comment/delete': {
      const target = state.comments[op.commentId]
      if (!target) return state
      const comments: Record<string, Comment> = {}
      for (const comment of Object.values(state.comments)) {
        if (comment.id === op.commentId || comment.parentId === op.commentId) continue
        comments[comment.id] = comment
      }
      return { ...state, comments }
    }

    case 'comment/setResolved': {
      const comment = state.comments[op.commentId]
      if (!comment || comment.resolved === op.resolved) return state
      return {
        ...state,
        comments: { ...state.comments, [op.commentId]: { ...comment, resolved: op.resolved } }
      }
    }

    case 'file/move': {
      const node = state.files[op.nodeId]
      if (!node || node.parentId === op.parentId) return state
      if (op.parentId !== null) {
        const target = state.files[op.parentId]
        if (!target || target.kind !== 'folder') return state
        // A folder can never be moved into itself or its own subtree.
        if (isSelfOrDescendant(state, op.parentId, op.nodeId)) return state
      }
      return {
        ...state,
        files: { ...state.files, [op.nodeId]: { ...node, parentId: op.parentId } }
      }
    }
  }
}

/**
 * Store a track's macros in canonical form: undefined removes the field
 * entirely (never `macros: undefined`), so a fully-reset track is
 * indistinguishable from one that never had macros. No-change = same state.
 */
function withTrackMacros(
  state: ProjectState,
  trackId: TrackId,
  macros: readonly TrackMacro[] | undefined
): ProjectState {
  const track = state.tracks[trackId]
  if (!track || macrosEqual(macros, track.macros)) return state
  const { macros: _dropped, ...rest } = track
  const updated: Track = macros ? { ...rest, macros } : rest
  return { ...state, tracks: { ...state.tracks, [trackId]: updated } }
}

function updateTrack(
  state: ProjectState,
  trackId: TrackId,
  fn: (track: Track) => Track
): ProjectState {
  const track = state.tracks[trackId]
  if (!track) return state
  const next = fn(track)
  if (next === track) return state
  return { ...state, tracks: { ...state.tracks, [trackId]: next } }
}

function updateClip(
  state: ProjectState,
  clipId: ClipId,
  fn: (clip: Clip) => Clip
): ProjectState {
  const clip = state.clips[clipId]
  if (!clip) return state
  const next = fn(clip)
  if (next === clip) return state
  return { ...state, clips: { ...state.clips, [clipId]: next } }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

export { clipsOfTrack }
