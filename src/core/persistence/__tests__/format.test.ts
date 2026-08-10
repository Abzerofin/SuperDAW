import { describe as suite, expect, test } from 'vitest'
import { createEmptyProject } from '../../model/types'
import { DEFAULT_PROJECT_SETTINGS } from '../../model/projectSettings'
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
      parentId: null,
      frozenAssetId: null,
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
      color: null,      fadeIn: 120,
      fadeOut: 240,

      reverse: false,

      pitch: 0,

      stretch: 1,
      loopLength: 0
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

  test('routing edges round-trip; malformed or invalid ones are dropped on load', () => {
    let state = sampleState()
    state = apply(state, {
      type: 'plugin/add',
      instance: {
        id: 'fx1',
        trackId: 't1',
        descriptor: { format: 'builtin', uid: 'superdaw.eq3', name: 'EQ', vendor: 'SuperDAW', version: '1' },
        enabled: true,
        rank: 1,
        params: {},
        stateBlob: null
      }
    })
    state = apply(state, {
      type: 'route/addMany',
      routes: [
        { id: 'r1', trackId: 't1', from: 'in', to: 'fx1' },
        { id: 'r2', trackId: 't1', from: 'fx1', to: 'out' }
      ]
    })
    const parsed = parseProjectJson(serializeProjectJson(state, []))
    expect(parsed.state.routes).toEqual(state.routes)

    // A doctored file: dangling endpoint, wrong shape, and one good edge.
    const doctored = {
      ...state,
      routes: {
        r1: state.routes['r1'],
        bad1: { id: 'bad1', trackId: 't1', from: 'ghost-plugin', to: 'out' },
        bad2: { id: 'bad2', trackId: 't1', from: 'in' } // missing `to`
      }
    }
    const cleaned = parseProjectJson(JSON.stringify({ formatVersion: 3, state: doctored, assets: [] }))
    expect(Object.keys(cleaned.state.routes)).toEqual(['r1'])

    // Pre-routing files come back with an empty routes map.
    const legacyState = { ...state } as Record<string, unknown>
    delete legacyState.routes
    const legacy = parseProjectJson(JSON.stringify({ formatVersion: 3, state: legacyState, assets: [] }))
    expect(legacy.state.routes).toEqual({})
  })

  test('round-trips lineage and op log; pre-v3 files come back without them', () => {
    const state = sampleState()
    const lineage = { projectId: 'prj_1', originTime: 1234, origin: createEmptyProject('Origin') }
    const opLog = [
      {
        id: 'op_1',
        userId: 'u1',
        time: 2000,
        op: { type: 'track/rename', trackId: 't1', name: 'Renamed' } as const
      }
    ]
    const parsed = parseProjectJson(serializeProjectJson(state, [], lineage, opLog))
    expect(parsed.lineage?.projectId).toBe('prj_1')
    expect(parsed.lineage?.originTime).toBe(1234)
    expect(parsed.lineage?.origin.name).toBe('Origin')
    expect(parsed.opLog).toEqual(opLog)

    // A v2-era file (no lineage) parses with both fields absent.
    const legacy = parseProjectJson(JSON.stringify({ formatVersion: 2, state, assets: [] }))
    expect(legacy.lineage).toBeUndefined()
    expect(legacy.opLog).toBeUndefined()

    // A corrupt log is dropped whole rather than merged from.
    const corrupt = parseProjectJson(
      JSON.stringify({ formatVersion: 3, state, assets: [], lineage, opLog: [{ id: 42 }] })
    )
    expect(corrupt.opLog).toBeUndefined()
    expect(corrupt.lineage?.projectId).toBe('prj_1')
  })

  test('project settings round-trip; old and doctored files normalize', () => {
    let state = sampleState()
    state = apply(state, {
      type: 'project/updateSettings',
      patch: { loudnessTargetLufs: -14, defaultFadeTicks: 96, exportFormat: 'mp3', exportBitDepth: 24 }
    })
    const parsed = parseProjectJson(serializeProjectJson(state, []))
    expect(parsed.state.settings).toEqual(state.settings)

    // Pre-settings files (the whole v1–v3 era) come back with defaults.
    const legacyState = { ...sampleState() } as Record<string, unknown>
    delete legacyState.settings
    const legacy = parseProjectJson(
      JSON.stringify({ formatVersion: 3, state: legacyState, assets: [] })
    )
    expect(legacy.state.settings).toEqual(DEFAULT_PROJECT_SETTINGS)

    // Doctored values re-earn their place: clamped or replaced by defaults.
    const doctored = {
      ...sampleState(),
      settings: { loudnessTargetLufs: -500, swingPercent: 'evil', extraKey: true }
    }
    const cleaned = parseProjectJson(
      JSON.stringify({ formatVersion: 3, state: doctored, assets: [] })
    )
    expect(cleaned.state.settings.loudnessTargetLufs).toBe(-36)
    expect(cleaned.state.settings.swingPercent).toBe(DEFAULT_PROJECT_SETTINGS.swingPercent)
    expect('extraKey' in cleaned.state.settings).toBe(false)
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

  test('pre-playback files load with reverse/pitch/stretch defaulted on clips', () => {
    const state = sampleState()
    const legacyClips = Object.fromEntries(
      Object.entries(state.clips).map(([id, c]) => {
        const { reverse: _r, pitch: _p, stretch: _s, ...legacy } = c
        return [id, legacy]
      })
    )
    const legacyState = { ...state, clips: legacyClips }
    const parsed = parseProjectJson(JSON.stringify({ formatVersion: 2, state: legacyState, assets: [] }))
    expect(parsed.state.clips['c1'].reverse).toBe(false)
    expect(parsed.state.clips['c1'].pitch).toBe(0)
    expect(parsed.state.clips['c1'].stretch).toBe(1)
  })

  test('legacy boolean-loop clips migrate: enabled keeps its period, disabled becomes 0', () => {
    const state = sampleState()
    const withLoop = {
      ...state,
      clips: Object.fromEntries(
        Object.entries(state.clips).map(([id, c], i) => [
          id,
          { ...c, loop: i === 0, loopLength: 480 }
        ])
      )
    }
    const parsed = parseProjectJson(
      JSON.stringify({ formatVersion: 2, state: withLoop, assets: [] })
    )
    expect('loop' in parsed.state.clips['c1']).toBe(false)
    expect(parsed.state.clips['c1'].loopLength).toBe(480) // loop: true → period survives

    // loop: false drops the stored period; files from before looping → 0.
    const withLoopOff = {
      ...state,
      clips: Object.fromEntries(
        Object.entries(state.clips).map(([id, c]) => [id, { ...c, loop: false, loopLength: 480 }])
      )
    }
    const off = parseProjectJson(
      JSON.stringify({ formatVersion: 2, state: withLoopOff, assets: [] })
    )
    expect(off.state.clips['c1'].loopLength).toBe(0)
    const plain = parseProjectJson(JSON.stringify({ formatVersion: 2, state, assets: [] }))
    expect(plain.state.clips['c1'].loopLength).toBe(0)
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
