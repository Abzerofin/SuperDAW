import type { ProjectState, Track, TrackId, TrackKind } from '@core/model/types'
import { pluginsOfTrack } from '@core/model/types'
import { newId } from '@core/model/ids'
import { synthDefaults } from '@core/model/effects'
import { nextTrackColor } from './colors'
import {
  TRACK_PRESET_EXTENSION,
  parseTrackPreset,
  serializeTrackPreset,
  trackFromPreset
} from '@core/persistence/trackPreset'
import { renderTrackFreeze } from '@audio/render'
import { encodeWavPcm16 } from '@audio/wav'
import { projectStore } from '@/state/projectStore'
import { assetStore } from '@/state/audioInstance'
import { externalPluginHost } from '@/state/externalPlugins'
import { selection } from '@/state/selection'

/**
 * Track-level actions behind the header context menu. Everything persistent
 * goes through ops; freezing follows the recording pattern — produce the
 * binary locally, register it as a normal asset (which auto-offers to
 * session peers), then dispatch the op that references it by id.
 */

/**
 * Create an empty track (audio, MIDI, or a folder bus) at the end.
 * Returns it so callers that follow up with clip ops (file import) can
 * reference the track they just made.
 */
export function createTrack(kind: TrackKind, name?: string): Track {
  const count = projectStore.state.trackOrder.length
  const label = kind === 'audio' ? 'Audio' : kind === 'midi' ? 'MIDI' : 'Folder'
  const track: Track = {
    id: newId('trk'),
    kind,
    name: name?.trim() || `${label} ${count + 1}`,
    color: nextTrackColor(count),
    muted: false,
    soloed: false,
    parentId: null,
    frozenAssetId: null,
    volume: 1,
    pan: 0,
    synth: kind === 'midi' ? synthDefaults() : {}
  }
  projectStore.dispatch({
    type: 'track/create',
    track,
    index: count,
    clips: [],
    automation: [],
    notes: [],
    plugins: []
  })
  // A brand-new track is what you're about to work on — the Effects dock
  // follows the selection.
  selection.selectTrack(track.id)
  return track
}

/**
 * Shift-click a header: select every track between the focused one and
 * this one, in trackOrder terms.
 */
export function selectTrackRange(state: ProjectState, trackId: TrackId): void {
  const anchor = selection.selectedTrackId
  const order = state.trackOrder
  const to = order.indexOf(trackId)
  const from = anchor ? order.indexOf(anchor) : -1
  if (to === -1 || from === -1) {
    selection.selectTrack(trackId)
    return
  }
  const [lo, hi] = from <= to ? [from, to] : [to, from]
  // Focus stays on the clicked track so a further Shift-click extends from
  // the original anchor rather than walking away from it.
  selection.selectTracks(order.slice(lo, hi + 1), anchor ?? trackId)
}

/**
 * Wrap the selected tracks in a new folder bus — one op, so undo removes
 * the folder and restores every track's place in a single step. Tracks
 * already inside the selection's own folders come along; a folder that is
 * itself selected brings its subtree implicitly (its children keep it as
 * their parent).
 */
export function groupTracksIntoFolder(trackIds: readonly TrackId[]): void {
  const state = projectStore.state
  // Drop any track whose ancestor is also selected: moving the ancestor
  // already moves it, and re-parenting both would flatten the nesting.
  const selected = new Set(trackIds)
  const members = state.trackOrder.filter((id) => {
    if (!selected.has(id)) return false
    let parent = state.tracks[id]?.parentId ?? null
    while (parent) {
      if (selected.has(parent)) return false
      parent = state.tracks[parent]?.parentId ?? null
    }
    return true
  })
  if (members.length === 0) return
  const count = state.trackOrder.length
  const folderId = newId('trk')
  projectStore.dispatch({
    type: 'track/group',
    folder: {
      id: folderId,
      kind: 'folder',
      name: `Group ${count + 1}`,
      color: nextTrackColor(count),
      muted: false,
      soloed: false,
      // The new folder takes the shared parent of its members when they
      // all live in the same one, so grouping inside a folder stays inside.
      parentId: commonParentOf(state, members),
      frozenAssetId: null,
      volume: 1,
      pan: 0,
      synth: {}
    },
    index: Math.min(...members.map((id) => state.trackOrder.indexOf(id))),
    trackIds: members
  })
  selection.selectTrack(folderId)
}

/** Dissolve a folder, leaving its tracks where they are. */
export function ungroupFolder(folderId: TrackId): void {
  const state = projectStore.state
  const folder = state.tracks[folderId]
  if (!folder || folder.kind !== 'folder') return
  const children = state.trackOrder.filter((id) => state.tracks[id]?.parentId === folderId)
  if (children.length === 0) {
    projectStore.dispatch({ type: 'track/delete', trackId: folderId })
    return
  }
  // The folder's own index is where its first child lands once it is gone.
  const at = state.trackOrder.indexOf(folderId)
  projectStore.dispatch({
    type: 'track/ungroup',
    folderId,
    restore: children.map((id, i) => ({ trackId: id, parentId: folder.parentId, index: at + i }))
  })
}

function commonParentOf(state: ProjectState, trackIds: readonly TrackId[]): TrackId | null {
  const first = state.tracks[trackIds[0]]?.parentId ?? null
  return trackIds.every((id) => (state.tracks[id]?.parentId ?? null) === first) ? first : null
}

/** Tracks currently rendering a freeze (ephemeral; drives the ❄ spinner). */
export const freezingTracks = new Set<TrackId>()

export async function freezeTrack(trackId: TrackId): Promise<void> {
  const state = projectStore.state
  const track = state.tracks[trackId]
  if (!track || track.kind === 'folder' || track.frozenAssetId || freezingTracks.has(trackId)) return

  freezingTracks.add(trackId)
  try {
    // Freezing is where external (VST3) inserts get their audio: they
    // cannot run in the renderer's graph, so their processing happens here
    // and bakes into the asset — which then reaches collaborators who
    // don't own the plugin through the ordinary asset transfer.
    const rendered = await renderTrackFreeze(
      state,
      trackId,
      assetStore,
      externalPluginHost() ?? undefined
    )
    if (!rendered) return // nothing on the track — nothing to freeze
    const channels: Float32Array[] = []
    for (let ch = 0; ch < rendered.numberOfChannels; ch++) {
      channels.push(rendered.getChannelData(ch))
    }
    const wav = encodeWavPcm16(channels, rendered.sampleRate)
    const asset = assetStore.addAudio(`Frozen — ${track.name}.wav`, 'wav', wav, rendered)
    projectStore.dispatch({ type: 'track/freeze', trackId, assetId: asset.id })
  } finally {
    freezingTracks.delete(trackId)
  }
}

export function unfreezeTrack(trackId: TrackId): void {
  projectStore.dispatch({ type: 'track/unfreeze', trackId })
}

// ---------- Presets ----------

export async function saveTrackPreset(trackId: TrackId): Promise<void> {
  const state = projectStore.state
  const track = state.tracks[trackId]
  if (!track) return
  const json = serializeTrackPreset(track, pluginsOfTrack(state, trackId), true)
  const data = new TextEncoder().encode(json)
  const name = `${track.name.trim() || 'Track'}.${TRACK_PRESET_EXTENSION}`
  const bridge = window.superdaw
  if (bridge) {
    await bridge.exportFile({
      data,
      defaultName: name,
      filterName: 'SuperDAW Track Preset',
      ext: TRACK_PRESET_EXTENSION
    })
    return
  }
  const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }))
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = name
  anchor.click()
  URL.revokeObjectURL(url)
}

/** Load a preset file and create a new track from it (one undoable op). */
export async function loadTrackPreset(): Promise<void> {
  const bridge = window.superdaw
  if (bridge) {
    const result = await bridge.openFile({
      filterName: 'SuperDAW Track Preset',
      ext: TRACK_PRESET_EXTENSION
    })
    if (result) createTrackFromPresetText(new TextDecoder().decode(result.data), result.name)
    return
  }
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = `.${TRACK_PRESET_EXTENSION}`
  input.onchange = async () => {
    const file = input.files?.[0]
    if (file) createTrackFromPresetText(await file.text(), file.name)
  }
  input.click()
}

function createTrackFromPresetText(text: string, fileName: string): void {
  let preset
  try {
    preset = parseTrackPreset(text)
  } catch (error) {
    window.alert(error instanceof Error ? error.message : 'Could not read the preset file')
    return
  }
  const fallback = fileName.replace(/\.[^.]+$/, '') || preset.name
  const { track, plugins } = trackFromPreset(preset, fallback)
  projectStore.dispatch({
    type: 'track/create',
    track,
    index: projectStore.state.trackOrder.length,
    clips: [],
    automation: [],
    notes: [],
    plugins
  })
}
