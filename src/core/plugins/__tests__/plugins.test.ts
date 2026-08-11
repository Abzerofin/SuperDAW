import { describe as suite, expect, test } from 'vitest'
import type { PluginInstance, ProjectState, Track } from '../../model/types'
import { createEmptyProject } from '../../model/types'
import { apply } from '../../ops/apply'
import { invert } from '../../ops/invert'
import type { ParamDef } from '../../model/effects'
import { clampParam } from '../../model/effects'
import type { PluginDescriptor } from '../descriptor'
import { descriptorKey, isPluginDescriptor, matchDescriptor, pluginSearchUrl } from '../descriptor'
import { builtinEffectDescriptor, paramDefsOf, pluginDefaults } from '../builtin'
import { pluginManifest } from '../manifest'

function track(id: string): Track {
  return {
    id,
    kind: 'audio',
    name: id,
    color: '#5b8def',
    muted: false,
    soloed: false,
    parentId: null,
    frozenAssetId: null,
    volume: 1,
    pan: 0,
    synth: {}
  }
}

const VST: PluginDescriptor = {
  format: 'vst3',
  uid: 'ABCD1234',
  name: 'FabFilter Pro-Q 3',
  vendor: 'FabFilter',
  version: '3.24',
  paramDefs: {
    gain: { label: 'Gain', min: -30, max: 30, default: 0, unit: 'dB', digits: 1 }
  }
}

function instance(id: string, trackId: string, descriptor: PluginDescriptor): PluginInstance {
  return {
    id,
    trackId,
    descriptor,
    enabled: true,
    rank: 1,
    params: pluginDefaults(descriptor),
    stateBlob: null
  }
}

function stateWithTracks(): ProjectState {
  let s = createEmptyProject('P')
  for (const id of ['t1', 't2']) {
    s = apply(s, {
      type: 'track/create',
      track: track(id),
      index: 99,
      clips: [],
      automation: [],
      notes: [],
      plugins: []
    })
  }
  return s
}

suite('descriptor matching', () => {
  const want = builtinEffectDescriptor('eq3')

  test('exact: same format, uid and version', () => {
    expect(matchDescriptor(want, builtinEffectDescriptor('eq3'))).toBe('exact')
  })

  test('version: same format and uid, different version', () => {
    expect(matchDescriptor(want, { ...want, version: '2.0.0' })).toBe('version')
  })

  test('format: same vendor and name in another format — never auto-substituted', () => {
    const vst3Twin: PluginDescriptor = { ...want, format: 'vst3', uid: 'other-uid' }
    expect(matchDescriptor(want, vst3Twin)).toBe('format')
  })

  test('none: unrelated plugin', () => {
    expect(matchDescriptor(want, VST)).toBe('none')
  })

  test('descriptorKey is identity (format + uid), not version', () => {
    expect(descriptorKey(want)).toBe(descriptorKey({ ...want, version: '9.9.9' }))
    expect(descriptorKey(want)).not.toBe(descriptorKey({ ...want, format: 'vst3' }))
  })
})

suite('descriptor validation', () => {
  const def = { label: 'Gain', min: -30, max: 30, default: 0, unit: 'dB', digits: 1 }
  const withDefs = (paramDefs: unknown): unknown => ({ ...VST, paramDefs })

  test('accepts identity-only descriptors and healthy paramDefs snapshots', () => {
    const { paramDefs: _defs, ...bare } = VST
    expect(isPluginDescriptor(bare)).toBe(true)
    expect(isPluginDescriptor(VST)).toBe(true)
    // min === max is a degenerate but usable range
    expect(isPluginDescriptor(withDefs({ vol: { ...def, min: 5, max: 5 } }))).toBe(true)
  })

  test('rejects doctored paramDefs whole — the reducer clamps with these', () => {
    // { min:'a', max:'b' } would make clampParam emit NaN into the synced
    // document on every setParam; the descriptor never enters state.
    expect(isPluginDescriptor(withDefs({ vol: { ...def, min: 'a', max: 'b' } }))).toBe(false)
    expect(isPluginDescriptor(withDefs({ vol: { ...def, min: 10, max: -10 } }))).toBe(false)
    expect(isPluginDescriptor(withDefs({ vol: { ...def, default: NaN } }))).toBe(false)
    expect(isPluginDescriptor(withDefs({ vol: { ...def, digits: Infinity } }))).toBe(false)
    expect(isPluginDescriptor(withDefs({ vol: { ...def, label: 3 } }))).toBe(false)
    expect(isPluginDescriptor(withDefs({ vol: { ...def, unit: null } }))).toBe(false)
    expect(isPluginDescriptor(withDefs({ vol: null }))).toBe(false)
    expect(isPluginDescriptor(withDefs(null))).toBe(false)
    expect(isPluginDescriptor(withDefs([def]))).toBe(false)
  })
})

suite('clampParam hardening', () => {
  const junk = { label: 'V', min: 'a', max: 'b', default: 0, unit: '', digits: 1 } as unknown as ParamDef

  test('junk min/max never emits NaN: finite input passes through', () => {
    expect(clampParam(junk, 5)).toBe(5)
  })

  test('junk def with non-finite input falls back to a finite default', () => {
    expect(clampParam(junk, NaN)).toBe(0)
    const junkDefault = { ...junk, default: 'x' } as unknown as ParamDef
    expect(clampParam(junkDefault, NaN)).toBe(0)
  })

  test('healthy defs clamp as before', () => {
    const gain: ParamDef = { label: 'Gain', min: -30, max: 30, default: 0, unit: 'dB', digits: 1 }
    expect(clampParam(gain, 100)).toBe(30)
    expect(clampParam(gain, NaN)).toBe(0)
    expect(clampParam(undefined, NaN)).toBe(0)
  })
})

suite('plugin ops with descriptors', () => {
  test('builtin add clamps params against core defs', () => {
    const s = apply(stateWithTracks(), {
      type: 'plugin/add',
      instance: { ...instance('p1', 't1', builtinEffectDescriptor('eq3')), params: { low: 99 } }
    })
    expect(s.plugins['p1'].params.low).toBe(12)
    expect(s.plugins['p1'].params.mid).toBe(0) // missing params filled from defaults
  })

  test('unknown builtin uid is rejected', () => {
    const s = stateWithTracks()
    const bogus: PluginDescriptor = {
      format: 'builtin',
      uid: 'superdaw.doesnotexist',
      name: 'Ghost',
      vendor: 'SuperDAW',
      version: '1.0.0'
    }
    expect(apply(s, { type: 'plugin/add', instance: instance('p1', 't1', bogus) })).toBe(s)
  })

  test('external plugin clamps via its paramDefs snapshot', () => {
    let s = apply(stateWithTracks(), {
      type: 'plugin/add',
      instance: instance('p1', 't1', VST)
    })
    s = apply(s, { type: 'plugin/setParam', instanceId: 'p1', param: 'gain', value: 100 })
    expect(s.plugins['p1'].params.gain).toBe(30)
    // Unknown param against a known def table is dropped
    expect(apply(s, { type: 'plugin/setParam', instanceId: 'p1', param: 'nope', value: 1 })).toBe(s)
  })

  test('a junk defs snapshot in state cannot put NaN in the document (belt and braces)', () => {
    // Validation rejects such a descriptor at every file boundary; if one
    // is ever in state anyway, the hardened clamp still yields finite.
    const junkDesc = {
      ...VST,
      uid: 'junk',
      paramDefs: { vol: { label: 'V', min: 'a', max: 'b', default: 0, unit: '', digits: 1 } }
    } as unknown as PluginDescriptor
    let s = apply(stateWithTracks(), {
      type: 'plugin/add',
      instance: { ...instance('p1', 't1', junkDesc), params: { vol: 3 } }
    })
    expect(s.plugins['p1'].params.vol).toBe(3)
    s = apply(s, { type: 'plugin/setParam', instanceId: 'p1', param: 'vol', value: 7 })
    expect(s.plugins['p1'].params.vol).toBe(7)
  })

  test('external plugin without paramDefs passes finite values, drops non-finite', () => {
    const bare: PluginDescriptor = { ...VST, uid: 'bare', paramDefs: undefined }
    let s = apply(stateWithTracks(), {
      type: 'plugin/add',
      instance: { ...instance('p1', 't1', bare), params: { x: 3, bad: NaN } }
    })
    expect(s.plugins['p1'].params).toEqual({ x: 3 })
    s = apply(s, { type: 'plugin/setParam', instanceId: 'p1', param: 'y', value: 7 })
    expect(s.plugins['p1'].params.y).toBe(7)
    expect(apply(s, { type: 'plugin/setParam', instanceId: 'p1', param: 'y', value: Infinity })).toBe(s)
  })

  test('external plugin add/remove round-trips through invert (stateBlob preserved)', () => {
    const before = stateWithTracks()
    const inst = { ...instance('p1', 't2', VST), stateBlob: 'b64chunk' }
    const add = { type: 'plugin/add', instance: inst } as const
    const after = apply(before, add)
    const undo = invert(before, add)!
    expect(apply(after, undo)).toEqual(before)
    const remove = { type: 'plugin/remove', instanceId: 'p1' } as const
    const redo = invert(after, remove)!
    expect(apply(apply(after, remove), redo)).toEqual(after)
    expect(after.plugins['p1'].stateBlob).toBe('b64chunk')
  })
})

suite('plugin manifest', () => {
  test('derives distinct descriptors with their tracks, in track order', () => {
    let s = stateWithTracks()
    s = apply(s, { type: 'plugin/add', instance: instance('p1', 't2', VST) })
    s = apply(s, {
      type: 'plugin/add',
      instance: instance('p2', 't1', builtinEffectDescriptor('reverb'))
    })
    s = apply(s, { type: 'plugin/add', instance: { ...instance('p3', 't1', VST), rank: 2 } })
    const manifest = pluginManifest(s)
    expect(manifest).toHaveLength(2)
    // Both first appear on t1 → alphabetical tie-break
    expect(manifest[0].descriptor.name).toBe('FabFilter Pro-Q 3')
    expect(manifest[0].instances).toHaveLength(2)
    expect(manifest[0].trackIds).toEqual(['t1', 't2'])
    expect(manifest[1].descriptor.name).toBe('Reverb')
    expect(manifest[1].trackIds).toEqual(['t1'])
  })
})

suite('builtin defs', () => {
  test('paramDefsOf resolves builtins by uid and externals by snapshot', () => {
    expect(paramDefsOf(builtinEffectDescriptor('delay'))?.time).toBeDefined()
    expect(paramDefsOf(VST)?.gain.max).toBe(30)
    expect(paramDefsOf({ ...VST, paramDefs: undefined })).toBeNull()
  })
})

suite('pluginSearchUrl', () => {
  test('builds a search from the plugin identity', () => {
    const url = new URL(pluginSearchUrl(VST))
    expect(url.origin).toBe('https://duckduckgo.com')
    expect(url.searchParams.get('q')).toBe('FabFilter FabFilter Pro-Q 3 VST3 plugin')
  })

  test('a hostile descriptor cannot escape the query — the origin is fixed', () => {
    // Descriptors arrive from a collaborator's machine and land in a link
    // that Electron hands to shell.openExternal, so identity fields are
    // untrusted input. Every one of these must stay INSIDE the query.
    const hostile = pluginSearchUrl({
      ...VST,
      name: 'evil" onclick="steal()',
      vendor: 'file:///C:/Windows/System32?&#'
    })
    const url = new URL(hostile)
    expect(url.origin).toBe('https://duckduckgo.com')
    expect(url.protocol).toBe('https:')
    expect(hostile.startsWith('https://duckduckgo.com/?q=')).toBe(true)
    // The whole payload survives as ONE query param, escaped — not as
    // extra params, a fragment, or a second URL.
    expect(url.searchParams.get('q')).toContain('file:///C:/Windows/System32?&#')
    expect([...url.searchParams.keys()]).toEqual(['q'])
    expect(url.hash).toBe('')
  })

  test('omits empty identity fields rather than emitting blank terms', () => {
    const url = new URL(pluginSearchUrl({ ...VST, vendor: '  ' }))
    expect(url.searchParams.get('q')).toBe('FabFilter Pro-Q 3 VST3 plugin')
  })
})
