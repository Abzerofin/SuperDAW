import type { Clip, ProjectState, Track, TrackKind } from '@core/model/types'
import { barsToTicks } from '@core/model/timebase'
import { newId } from '@core/model/ids'
import { synthDefaults } from '@core/model/effects'
import { nextTrackColor } from '@/lib/colors'

/**
 * Seed content so a first run shows a working timeline instead of an empty
 * screen. Replaced by real project files in the persistence milestone.
 */
export function createDemoProject(): ProjectState {
  const sig = [4, 4] as const
  const bars = (n: number): number => barsToTicks(n, sig)

  const tracks: Track[] = []
  const clips: Clip[] = []

  const addTrack = (name: string, kind: TrackKind): Track => {
    const track: Track = {
      id: newId('trk'),
      kind,
      name,
      color: nextTrackColor(tracks.length),
      muted: false,
      soloed: false,
      parentId: null,
      frozenAssetId: null,
      volume: 1,
      pan: 0,
      synth: kind === 'midi' ? synthDefaults() : {}
    }
    tracks.push(track)
    return track
  }

  const addClip = (track: Track, name: string, startBars: number, lengthBars: number): void => {
    clips.push({
      id: newId('clp'),
      trackId: track.id,
      name,
      start: bars(startBars),
      duration: bars(lengthBars),
      assetId: null,
      offset: 0,
      color: null,
      fadeIn: 0,
      fadeOut: 0,
      reverse: false,
      pitch: 0,
      stretch: 1,
      loopLength: 0
    })
  }

  const drums = addTrack('Drums', 'audio')
  const bass = addTrack('Bass', 'audio')
  const keys = addTrack('Keys', 'midi')
  const vox = addTrack('Lead Vox', 'audio')

  addClip(drums, 'Drum Loop', 0, 8)
  addClip(drums, 'Drum Fill', 8, 1)
  addClip(bass, 'Bassline A', 4, 8)
  addClip(keys, 'Chords', 0, 4)
  addClip(keys, 'Chords', 8, 4)
  addClip(vox, 'Verse 1', 8, 8)

  return {
    name: 'Demo Project',
    createdAt: 0,
    tempo: 120,
    timeSignature: sig,
    tracks: Object.fromEntries(tracks.map((t) => [t.id, t])),
    trackOrder: tracks.map((t) => t.id),
    clips: Object.fromEntries(clips.map((c) => [c.id, c])),
    files: {},
    chat: [],
    comments: {},
    masterVolume: 1,
    automation: {},
    notes: {},
    plugins: {}
  }
}
