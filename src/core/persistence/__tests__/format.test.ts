import { describe as suite, expect, test } from 'vitest'
import { createEmptyProject } from '../../model/types'
import { apply } from '../../ops/apply'
import {
  FORMAT_VERSION,
  parseProjectJson,
  referencedAssetIds,
  serializeProjectJson
} from '../format'

function sampleState() {
  let s = createEmptyProject('Round Trip')
  s = { ...s, tempo: 133 }
  s = apply(s, {
    type: 'track/create',
    track: {
      id: 't1',
      kind: 'audio',
      name: 'T',
      color: '#fff',
      muted: false,
      soloed: true,
      volume: 0.9,
      pan: 0.25,
      synth: {}
    },
    index: 0,
    clips: [],
    automation: [{ id: 'ap1', trackId: 't1', param: 'volume', ticks: 480, value: 0.6 }],
    notes: [],
    plugins: []
  })
  s = apply(s, {
    type: 'clip/create',
    clip: {
      id: 'c1',
      trackId: 't1',
      name: 'C',
      start: 960,
      duration: 3840,
      assetId: 'ast_1',
      offset: 480,
      color: null
    },
    notes: [{ id: 'n1', clipId: 'c1', pitch: 60, start: 0, duration: 960, velocity: 100 }]
  })
  s = apply(s, {
    type: 'file/create',
    nodes: [
      { id: 'f1', parentId: null, kind: 'folder', name: 'Loops', assetId: null },
      { id: 'n1', parentId: 'f1', kind: 'audio', name: 'Kick', assetId: 'ast_2' }
    ]
  })
  return s
}

suite('project file format', () => {
  test('serialize -> parse round-trips the full document', () => {
    const state = sampleState()
    const assets = [
      { id: 'ast_1', name: 'a.wav', kind: 'audio' as const, ext: 'wav' },
      { id: 'ast_2', name: 'k.wav', kind: 'audio' as const, ext: 'wav' }
    ]
    const parsed = parseProjectJson(serializeProjectJson(state, assets))
    expect(parsed.formatVersion).toBe(FORMAT_VERSION)
    expect(parsed.state).toEqual(state)
    expect(parsed.assets).toEqual(assets)
  })

  test('referencedAssetIds collects clip and bay references', () => {
    expect([...referencedAssetIds(sampleState())].sort()).toEqual(['ast_1', 'ast_2'])
  })

  test('rejects corrupted and future-version files', () => {
    expect(() => parseProjectJson('not json')).toThrow(/corrupted/)
    expect(() => parseProjectJson('{"formatVersion":1}')).toThrow(/corrupted/)
    expect(() =>
      parseProjectJson(JSON.stringify({ formatVersion: 999, state: {}, assets: [] }))
    ).toThrow(/newer version/)
  })

  test('pre-mixer files load with default volume/pan on tracks', () => {
    const state = sampleState()
    const legacyTracks = Object.fromEntries(
      Object.entries(state.tracks).map(([id, t]) => {
        const { volume: _v, pan: _p, ...legacy } = t
        return [id, legacy]
      })
    )
    const { masterVolume: _m, automation: _a, ...rest } = state
    const legacyState = { ...rest, tracks: legacyTracks }
    const parsed = parseProjectJson(JSON.stringify({ formatVersion: 1, state: legacyState, assets: [] }))
    expect(parsed.state.tracks['t1'].volume).toBe(1)
    expect(parsed.state.tracks['t1'].pan).toBe(0)
    expect(parsed.state.masterVolume).toBe(1)
    expect(parsed.state.automation).toEqual({})
  })

  test('v1 files with legacy effects load as builtin plugin instances', () => {
    const state = sampleState()
    const { plugins: _plugins, ...rest } = state
    const legacyState = {
      ...rest,
      effects: {
        fx1: { id: 'fx1', trackId: 't1', type: 'eq3', enabled: false, rank: 2, params: { low: 3 } },
        fx2: { id: 'fx2', trackId: 't1', type: 'notAnEffect', enabled: true, rank: 1, params: {} }
      }
    }
    const parsed = parseProjectJson(
      JSON.stringify({ formatVersion: 1, state: legacyState, assets: [] })
    )
    const inst = parsed.state.plugins['fx1']
    expect(inst.descriptor).toMatchObject({ format: 'builtin', uid: 'superdaw.eq3' })
    expect(inst.enabled).toBe(false)
    expect(inst.rank).toBe(2)
    expect(inst.params).toEqual({ low: 3 })
    expect(inst.stateBlob).toBeNull()
    // Unknown legacy types are dropped, and the legacy key doesn't linger
    expect(parsed.state.plugins['fx2']).toBeUndefined()
    expect('effects' in parsed.state).toBe(false)
  })

  test('a v1 file missing a required section is rejected, not half-loaded', () => {
    const { files: _files, ...truncated } = sampleState()
    const text = JSON.stringify({ formatVersion: 1, state: truncated, assets: [] })
    expect(() => parseProjectJson(text)).toThrow(/corrupted/)
  })
})
