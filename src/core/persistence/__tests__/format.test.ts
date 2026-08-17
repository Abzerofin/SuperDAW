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
  s = apply(s, {
    type: 'pad/set',
    pad: {
      id: 'pad-r1c2',
      row: 1,
      col: 2,
      kind: 'sample',
      assetId: 'ast_pad',
      trackId: null,
      pitch: 60,
      clipId: null,
      name: 'Air horn',
      color: '#e06c75',
      gate: false
    }
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

  test('referencedAssetIds collects clip, bay, sampler and pad references', () => {
    let s = sampleState()
    s = apply(s, {
      type: 'track/create',
      track: {
        id: 'tm',
        kind: 'midi',
        name: 'S',
        color: '#fff',
        muted: false,
        soloed: false,
        parentId: null,
        frozenAssetId: null,
        volume: 1,
        pan: 0,
        synth: {}
      },
      index: 1,
      clips: [],
      automation: [],
      notes: [],
      plugins: []
    })
    s = apply(s, { type: 'track/setSampler', trackId: 'tm', assetId: 'ast_smp' })
    expect([...referencedAssetIds(s)].sort()).toEqual(['ast_1', 'ast_2', 'ast_pad', 'ast_smp'])
  })

  test('malformed pads in a doctored file are dropped on load', () => {
    const state = sampleState()
    const doctored = {
      ...state,
      pads: {
        ...state.pads,
        'pad-r9c9': { id: 'pad-r9c9', row: 9, col: 9, kind: 'sample', assetId: 'x' },
        evil: { id: 'evil', row: 0, col: 0, kind: 'sample', assetId: 'x' },
        'pad-r0c1': { id: 'pad-r0c1', row: 0, col: 1, kind: 'nope' }
      }
    }
    const cleaned = parseProjectJson(
      JSON.stringify({ formatVersion: 3, state: doctored, assets: [] })
    )
    expect(Object.keys(cleaned.state.pads)).toEqual(['pad-r1c2'])
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

  test('solo flag and stamp pointer survive save -> load; plain clips stay unflagged', () => {
    const state = sampleState()
    const solo = { ...state.clips['c1'], id: 'cs', freeLength: true }
    const stamp = { ...state.clips['c1'], id: 'cst', sourceClipId: 'c1' }
    const saved = { ...state, clips: { ...state.clips, cs: solo, cst: stamp } }
    const parsed = parseProjectJson(
      JSON.stringify({ formatVersion: 3, state: saved, assets: [] })
    )
    expect(parsed.state.clips['cs'].freeLength).toBe(true)
    expect(parsed.state.clips['cst'].sourceClipId).toBe('c1')
    // Absent means "measure-shaped" and "owns its own notes" — neither may
    // materialize as false/null, so a plain clip round-trips identically.
    expect('freeLength' in parsed.state.clips['c1']).toBe(false)
    expect('sourceClipId' in parsed.state.clips['c1']).toBe(false)
  })

  test('take-group fields survive save -> load; junk collapses to an ordinary clip', () => {
    const state = sampleState()
    const active = { ...state.clips['c1'], id: 'ta', takeGroupId: 'tg1', takeActive: true }
    const inactive = { ...state.clips['c1'], id: 'ti', takeGroupId: 'tg1' }
    // Doctored: an active flag without membership, and junk-typed fields.
    const junkActive = { ...state.clips['c1'], id: 'tj', takeActive: true }
    const junkGroup = { ...state.clips['c1'], id: 'tk', takeGroupId: 7 as never, takeActive: 1 as never }
    const saved = {
      ...state,
      clips: { ...state.clips, ta: active, ti: inactive, tj: junkActive, tk: junkGroup }
    }
    const parsed = parseProjectJson(
      JSON.stringify({ formatVersion: 3, state: saved, assets: [] })
    )
    expect(parsed.state.clips['ta'].takeGroupId).toBe('tg1')
    expect(parsed.state.clips['ta'].takeActive).toBe(true)
    expect(parsed.state.clips['ti'].takeGroupId).toBe('tg1')
    expect('takeActive' in parsed.state.clips['ti']).toBe(false)
    // Junk collapses to absent — the canonical form the reducer keeps.
    expect('takeActive' in parsed.state.clips['tj']).toBe(false)
    expect('takeGroupId' in parsed.state.clips['tk']).toBe(false)
    expect('takeActive' in parsed.state.clips['tk']).toBe(false)
    // Plain clips round-trip identically (absent stays absent).
    expect('takeGroupId' in parsed.state.clips['c1']).toBe(false)
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

  test('a real non-null stateBlob envelope survives save -> load intact', () => {
    // The exact envelope shape main writes when a VST3 editor closes
    // (see src/main/vst3State.ts): the producer's plugin state must come
    // back byte-identical from a project file.
    const envelope = '{"component":"AAECAwQFBgcICQ=="}'
    let state = sampleState()
    state = apply(state, {
      type: 'plugin/add',
      instance: {
        id: 'vst1',
        trackId: 't1',
        descriptor: { format: 'vst3', uid: '{5653-5445}', name: 'Verb', vendor: 'Acme', version: '1.0' },
        enabled: true,
        rank: 1,
        params: { '3': 0.25 },
        stateBlob: envelope
      }
    })
    expect(state.plugins['vst1'].stateBlob).toBe(envelope) // premise: the add kept it
    const parsed = parseProjectJson(serializeProjectJson(state, []))
    expect(parsed.state.plugins['vst1']).toEqual(state.plugins['vst1'])
    expect(parsed.state.plugins['vst1'].stateBlob).toBe(envelope)
  })

  test('doctored plugin instances are validated field by field on load', () => {
    const state = sampleState()
    const good = {
      id: 'ok',
      trackId: 't1',
      descriptor: { format: 'vst3', uid: 'u1', name: 'N', vendor: 'V', version: '1' },
      enabled: false,
      rank: 2,
      params: { '1': 0.5 },
      stateBlob: '{"component":"QUJD"}',
      graphX: 40,
      graphY: 12.5
    }
    const doctored = {
      ...state,
      plugins: {
        ok: good,
        // Load-bearing fields: fail one and the instance is dropped.
        noDescriptor: { ...good, id: 'noDescriptor', descriptor: undefined },
        badDescriptor: { ...good, id: 'badDescriptor', descriptor: { format: 'vst3', uid: 42 } },
        ghostTrack: { ...good, id: 'ghostTrack', trackId: 'no-such-track' },
        numberTrack: { ...good, id: 'numberTrack', trackId: 7 },
        notAnObject: 12,
        // Everything else is coerced, never trusted.
        messy: {
          id: 'messy',
          trackId: 't1',
          descriptor: good.descriptor,
          enabled: 'yes', // truthy junk -> default true, not "truthy"
          rank: Infinity,
          params: { fine: 1.5, text: 'x', nothing: null, deep: { a: 1 } },
          stateBlob: { component: 'QUJD' }, // non-string truthy must not survive
          graphX: 'left',
          graphY: Infinity
        },
        // The record key is the identity ops target — a lying inner id loses.
        renamed: { ...good, id: 'someOtherId' }
      }
    }
    const parsed = parseProjectJson(
      JSON.stringify({ formatVersion: 3, state: doctored, assets: [] })
    )
    expect(Object.keys(parsed.state.plugins).sort()).toEqual(['messy', 'ok', 'renamed'])
    expect(parsed.state.plugins['ok']).toEqual(good)
    expect(parsed.state.plugins['renamed'].id).toBe('renamed')
    const messy = parsed.state.plugins['messy']
    expect(messy.enabled).toBe(true)
    expect(Number.isFinite(messy.rank)).toBe(true)
    expect(messy.params).toEqual({ fine: 1.5 })
    expect(messy.stateBlob).toBeNull()
    expect('graphX' in messy).toBe(false)
    expect('graphY' in messy).toBe(false)
  })

  test('builtin params are clamped through core defs on load, exactly like plugin/add', () => {
    const state = sampleState()
    const compressor = {
      format: 'builtin',
      uid: 'superdaw.compressor',
      name: 'Compressor',
      vendor: 'SuperDAW',
      version: '1.0.0'
    }
    const doctored = {
      ...state,
      plugins: {
        // makeup 1e9 is FINITE, so a finiteness-only screen passes it —
        // and dbToGain(1e9) then blows up the engine at rewire time.
        comp: {
          id: 'comp',
          trackId: 't1',
          descriptor: compressor,
          enabled: true,
          rank: 1,
          params: { makeup: 1e9, threshold: -1e9, smuggled: 42 },
          stateBlob: null
        },
        // A builtin uid core doesn't know: the reducer rejects it in
        // plugin/add, so the load path must drop it too.
        ghost: {
          id: 'ghost',
          trackId: 't1',
          descriptor: { ...compressor, uid: 'superdaw.doesnotexist' },
          enabled: true,
          rank: 2,
          params: {},
          stateBlob: null
        }
      }
    }
    const parsed = parseProjectJson(
      JSON.stringify({ formatVersion: 3, state: doctored, assets: [] })
    )
    const params = parsed.state.plugins['comp'].params
    expect(params.makeup).toBe(24)
    expect(params.threshold).toBe(-60)
    expect('smuggled' in params).toBe(false)
    expect(params.ratio).toBe(4) // missing defined params fill from defaults
    expect(parsed.state.plugins['ghost']).toBeUndefined()
  })

  test('legacy v1 effects get the same clamp: out-of-range clamped, unknown keys dropped', () => {
    const { plugins: _plugins, ...rest } = sampleState()
    const legacyState = {
      ...rest,
      effects: {
        fx1: {
          id: 'fx1',
          trackId: 't1',
          type: 'compressor',
          enabled: true,
          rank: 1,
          params: { makeup: 1e9, smuggled: 7 }
        }
      }
    }
    const parsed = parseProjectJson(
      JSON.stringify({ formatVersion: 1, state: legacyState, assets: [] })
    )
    const params = parsed.state.plugins['fx1'].params
    expect(params.makeup).toBe(24)
    expect('smuggled' in params).toBe(false)
    expect(params.threshold).toBe(-24)
  })

  test('a descriptor with doctored paramDefs is rejected whole on load', () => {
    const state = sampleState()
    const def = { label: 'Vol', min: 0, max: 1, default: 0.5, unit: '', digits: 2 }
    const vst = (uid: string, paramDefs: unknown) => ({
      id: uid,
      trackId: 't1',
      descriptor: { format: 'vst3', uid, name: 'N', vendor: 'V', version: '1', paramDefs },
      enabled: true,
      rank: 1,
      params: { vol: 0.5 },
      stateBlob: null
    })
    const doctored = {
      ...state,
      plugins: {
        // String min/max would turn every later clamp into NaN — the
        // instance drops, like any other broken descriptor shape.
        strings: vst('strings', { vol: { ...def, min: 'a', max: 'b' } }),
        inverted: vst('inverted', { vol: { ...def, min: 1, max: 0 } }),
        healthy: vst('healthy', { vol: def })
      }
    }
    const parsed = parseProjectJson(
      JSON.stringify({ formatVersion: 3, state: doctored, assets: [] })
    )
    expect(Object.keys(parsed.state.plugins)).toEqual(['healthy'])
    expect(parsed.state.plugins['healthy'].params).toEqual({ vol: 0.5 })
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
    // Params load exactly as plugin/add would build them: stored values
    // kept, missing defined params filled from core defaults.
    expect(inst.params).toEqual({ low: 3, mid: 0, midFreq: 1000, high: 0 })
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
