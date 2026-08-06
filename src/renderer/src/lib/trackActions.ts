import type { TrackId, TrackKind } from '@core/model/types'
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

/**
 * Track-level actions behind the header context menu. Everything persistent
 * goes through ops; freezing follows the recording pattern — produce the
 * binary locally, register it as a normal asset (which auto-offers to
 * session peers), then dispatch the op that references it by id.
 */

/** Create an empty track (audio, MIDI, or a folder bus) at the end. */
export function createTrack(kind: TrackKind): void {
  const count = projectStore.state.trackOrder.length
  const label = kind === 'audio' ? 'Audio' : kind === 'midi' ? 'MIDI' : 'Folder'
  projectStore.dispatch({
    type: 'track/create',
    track: {
      id: newId('trk'),
      kind,
      name: `${label} ${count + 1}`,
      color: nextTrackColor(count),
      muted: false,
      soloed: false,
      parentId: null,
      frozenAssetId: null,
      volume: 1,
      pan: 0,
      synth: kind === 'midi' ? synthDefaults() : {}
    },
    index: count,
    clips: [],
    automation: [],
    notes: [],
    plugins: []
  })
}

/** Tracks currently rendering a freeze (ephemeral; drives the ❄ spinner). */
export const freezingTracks = new Set<TrackId>()

export async function freezeTrack(trackId: TrackId): Promise<void> {
  const state = projectStore.state
  const track = state.tracks[trackId]
  if (!track || track.kind === 'folder' || track.frozenAssetId || freezingTracks.has(trackId)) return

  freezingTracks.add(trackId)
  try {
    const rendered = await renderTrackFreeze(state, trackId, assetStore)
    if (!rendered) return // nothing on the track — nothing to freeze
    const channels: Float32Array[] = []
    for (let ch = 0; ch < rendered.numberOfChannels; ch++) {
      channels.push(rendered.getChannelData(ch))
    }
    const wav = encodeWavPcm16(channels, rendered.sampleRate)
    const asset = assetStore.restore(
      newId('ast'),
      `Frozen — ${track.name}.wav`,
      'audio',
      'wav',
      wav,
      rendered
    )
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
