import { describe as suite, expect, test } from 'vitest'
import type { PluginInstance, ProjectState, Track } from '@core/model/types'
import { createEmptyProject } from '@core/model/types'
import type { PluginDescriptor } from '@core/plugins/descriptor'
import { builtinEffectDescriptor } from '@core/plugins/builtin'
import { apply } from '@core/ops/apply'
import { segmentInserts, type ExternalPluginHost } from '../render'

/**
 * Chain ORDER is the property that matters here: an EQ before a saturator
 * does not sound like a saturator before an EQ. Freezing a track with VST3
 * inserts renders in segments, so these lock in that the segments come out
 * in rank order with nothing reordered, duplicated or silently dropped.
 */

const VST3 = (uid: string, name = uid): PluginDescriptor => ({
  format: 'vst3',
  uid,
  name,
  vendor: 'Test Vendor',
  version: '1.0.0'
})

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

function instance(
  id: string,
  descriptor: PluginDescriptor,
  rank: number,
  enabled = true
): PluginInstance {
  return { id, trackId: 't1', descriptor, enabled, rank, params: {}, stateBlob: null }
}

/** A host that can run every vst3 uid listed. */
function hostWith(...uids: string[]): ExternalPluginHost {
  return {
    has: (d) => d.format === 'vst3' && uids.includes(d.uid),
    process: async () => null
  }
}

function stateWith(...instances: PluginInstance[]): ProjectState {
  let s = apply(createEmptyProject('Test'), {
    type: 'track/create',
    track: track('t1'),
    index: 0,
    clips: [],
    automation: [],
    notes: [],
    plugins: []
  })
  for (const inst of instances) s = apply(s, { type: 'plugin/add', instance: inst })
  return s
}

/** Compact shape for assertions: [external?, ...instance ids]. */
const shape = (state: ProjectState, host: ExternalPluginHost): string[] =>
  segmentInserts(state, 't1', host).map(
    (seg) => `${seg.external ? 'vst3' : 'builtin'}:${seg.instances.map((i) => i.id).join(',')}`
  )

const EQ = builtinEffectDescriptor('eq3')
const DELAY = builtinEffectDescriptor('delay')

suite('segmentInserts', () => {
  test('keeps rank order and groups consecutive same-kind inserts', () => {
    const state = stateWith(
      instance('a', EQ, 1),
      instance('b', VST3('sat'), 2),
      instance('c', VST3('verb'), 3),
      instance('d', DELAY, 4)
    )
    expect(shape(state, hostWith('sat', 'verb'))).toEqual([
      'builtin:a',
      'vst3:b,c',
      'builtin:d'
    ])
  })

  test('alternating kinds produce one segment each, never merged', () => {
    const state = stateWith(
      instance('a', VST3('sat'), 1),
      instance('b', EQ, 2),
      instance('c', VST3('verb'), 3)
    )
    expect(shape(state, hostWith('sat', 'verb'))).toEqual(['vst3:a', 'builtin:b', 'vst3:c'])
  })

  test('rank, not insertion order, decides the sequence', () => {
    // Added c, a, b — but ranks say a, b, c.
    const state = stateWith(
      instance('c', DELAY, 30),
      instance('a', EQ, 10),
      instance('b', VST3('sat'), 20)
    )
    expect(shape(state, hostWith('sat'))).toEqual(['builtin:a', 'vst3:b', 'builtin:c'])
  })

  test('a VST3 the host does not have is bypassed, and does not split the run', () => {
    // 'ghost' is unavailable: the two builtins around it stay ONE segment,
    // matching live playback, where a missing insert simply is not there.
    const state = stateWith(
      instance('a', EQ, 1),
      instance('ghost', VST3('notinstalled'), 2),
      instance('b', DELAY, 3)
    )
    expect(shape(state, hostWith('sat'))).toEqual(['builtin:a,b'])
  })

  test('disabled inserts are skipped, bypassed rather than segmented', () => {
    const state = stateWith(
      instance('a', EQ, 1),
      instance('off', VST3('sat'), 2, false),
      instance('b', DELAY, 3)
    )
    expect(shape(state, hostWith('sat'))).toEqual(['builtin:a,b'])
  })

  test('with no external host available every insert is one builtin run', () => {
    const state = stateWith(
      instance('a', EQ, 1),
      instance('b', VST3('sat'), 2),
      instance('c', DELAY, 3)
    )
    expect(shape(state, hostWith())).toEqual(['builtin:a,c'])
  })

  test('a track with no inserts yields no segments', () => {
    expect(shape(stateWith(), hostWith('sat'))).toEqual([])
  })
})
