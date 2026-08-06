import { describe as suite, expect, test } from 'vitest'
import type { PluginInstance, ProjectState, Track } from '../../model/types'
import { createEmptyProject } from '../../model/types'
import { apply } from '../../ops/apply'
import { invert } from '../../ops/invert'
import type { PluginDescriptor } from '../descriptor'
import { descriptorKey, matchDescriptor } from '../descriptor'
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
