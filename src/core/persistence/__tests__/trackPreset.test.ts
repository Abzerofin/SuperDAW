import { describe as suite, expect, test } from 'vitest'
import type { Track } from '../../model/types'
import { createEmptyProject } from '../../model/types'
import { synthDefaults } from '../../model/effects'
import { builtinEffectDescriptor } from '../../plugins/builtin'
import { apply } from '../../ops/apply'
import {
  parseTrackPreset,
  serializeTrackPreset,
  trackFromPreset
} from '../trackPreset'

const midiTrack: Track = {
  id: 'tm',
  kind: 'midi',
  name: 'Warm Keys',
  color: '#8d6fd1',
  muted: true, // deliberately NOT part of a preset
  soloed: false,
  parentId: null,
  frozenAssetId: null,
  volume: 0.8,
  pan: -0.3,
  synth: { ...synthDefaults(), cutoff: 3 }
}

const inserts = [
  {
    id: 'fx1',
    trackId: 'tm',
    descriptor: builtinEffectDescriptor('reverb'),
    enabled: false,
    rank: 2,
    params: { mix: 0.4, decay: 2 },
    stateBlob: null
  }
]

suite('track presets', () => {
  test('serialize -> parse round-trips sound settings (not mute/solo/freeze)', () => {
    const parsed = parseTrackPreset(serializeTrackPreset(midiTrack, inserts, true))
    expect(parsed.trackName).toBe('Warm Keys')
    expect(parsed.track).toMatchObject({ kind: 'midi', color: '#8d6fd1', volume: 0.8, pan: -0.3 })
    expect(parsed.track.synth.cutoff).toBe(3)
    expect(parsed.plugins).toHaveLength(1)
    expect(parsed.plugins[0]).toMatchObject({ enabled: false, rank: 2 })
    expect(parsed.plugins[0].params.mix).toBeCloseTo(0.4)
  })

  test('omitting the name keeps presets anonymous', () => {
    const parsed = parseTrackPreset(serializeTrackPreset(midiTrack, inserts, false))
    expect(parsed.trackName).toBeUndefined()
  })

  test('out-of-range and junk values are clamped or dropped, never trusted', () => {
    const doctored = JSON.parse(serializeTrackPreset(midiTrack, inserts, true))
    doctored.track.volume = 99
    doctored.track.pan = -5
    doctored.plugins[0].params.mix = 1000
    doctored.plugins.push({ notAPlugin: true })
    const parsed = parseTrackPreset(JSON.stringify(doctored))
    expect(parsed.track.volume).toBeLessThanOrEqual(1.4)
    expect(parsed.track.pan).toBe(-1)
    expect(parsed.plugins).toHaveLength(1)
    expect(parsed.plugins[0].params.mix).toBeLessThanOrEqual(1)
  })

  test('rejects non-preset files', () => {
    expect(() => parseTrackPreset('not json')).toThrow(/corrupted/)
    expect(() => parseTrackPreset('{"kind":"something-else"}')).toThrow(/Not a SuperDAW/)
  })

  test('trackFromPreset materializes an applicable track/create with fresh ids', () => {
    const parsed = parseTrackPreset(serializeTrackPreset(midiTrack, inserts, true))
    const { track, plugins } = trackFromPreset(parsed, 'Fallback')
    expect(track.id).not.toBe('tm')
    expect(track.name).toBe('Warm Keys')
    expect(track.muted).toBe(false)
    expect(plugins[0].trackId).toBe(track.id)
    const s = apply(createEmptyProject('T'), {
      type: 'track/create',
      track,
      index: 0,
      clips: [],
      automation: [],
      notes: [],
      plugins
    })
    expect(s.tracks[track.id]).toBeDefined()
    expect(Object.keys(s.plugins)).toHaveLength(1)
  })
})
