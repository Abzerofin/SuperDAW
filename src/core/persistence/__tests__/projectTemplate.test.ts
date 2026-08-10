import { expect, suite, test } from 'vitest'
import { createEmptyProject, type ProjectState } from '../../model/types'
import { synthDefaults } from '../../model/effects'
import { builtinEffectDescriptor } from '../../plugins/builtin'
import {
  parseProjectTemplate,
  projectFromTemplate,
  serializeProjectTemplate
} from '../projectTemplate'

/** A project with a folder tree, synth params, insert chains and a route. */
function sampleState(): ProjectState {
  const base = createEmptyProject('Session Base', 1000)
  return {
    ...base,
    tempo: 92,
    timeSignature: [6, 8],
    masterVolume: 0.9,
    settings: {
      ...base.settings,
      loudnessTargetLufs: -14,
      swingPercent: 55,
      exportFormat: 'mp3'
    },
    tracks: {
      bus: {
        id: 'bus',
        kind: 'folder',
        name: 'Drum Bus',
        color: '#aa4444',
        muted: false,
        soloed: true, // must NOT survive into the template
        parentId: null,
        frozenAssetId: null,
        volume: 0.8,
        pan: 0,
        synth: {}
      },
      kick: {
        id: 'kick',
        kind: 'audio',
        name: 'Kick',
        color: '#44aa44',
        muted: true, // must not survive either
        soloed: false,
        parentId: 'bus',
        frozenAssetId: 'frozen-asset', // content — never templated
        volume: 1.1,
        pan: -0.2,
        synth: {}
      },
      keys: {
        id: 'keys',
        kind: 'midi',
        name: 'Keys',
        color: '#4444aa',
        muted: false,
        soloed: false,
        parentId: null,
        frozenAssetId: null,
        volume: 1,
        pan: 0.3,
        synth: { ...synthDefaults(), cutoff: 9 }
      }
    },
    trackOrder: ['bus', 'kick', 'keys'],
    plugins: {
      eq: {
        id: 'eq',
        trackId: 'kick',
        descriptor: builtinEffectDescriptor('eq3'),
        enabled: true,
        rank: 1,
        params: { low: 2 },
        stateBlob: null
      },
      ext: {
        id: 'ext',
        trackId: 'keys',
        descriptor: {
          format: 'vst3',
          uid: 'ABCD-1234',
          name: 'FabDelay',
          vendor: 'Vendor',
          version: '2.0'
        },
        enabled: false,
        rank: 1,
        params: { mix: 0.4 },
        stateBlob: 'b64chunk'
      }
    },
    routes: {
      r1: { id: 'r1', trackId: 'kick', from: 'in', to: 'eq' },
      r2: { id: 'r2', trackId: 'kick', from: 'eq', to: 'out' }
    }
  }
}

suite('project templates', () => {
  test('round-trip: setup survives, content and ephemera do not', () => {
    const state = sampleState()
    const parsed = parseProjectTemplate(serializeProjectTemplate(state, 'Band Setup'))
    const project = projectFromTemplate(parsed, 'New Song', 5000)

    expect(project.name).toBe('New Song')
    expect(project.createdAt).toBe(5000)
    expect(project.tempo).toBe(92)
    expect(project.timeSignature).toEqual([6, 8])
    expect(project.masterVolume).toBe(0.9)
    expect(project.settings).toEqual(state.settings)

    // Track tree preserved in order, with fresh ids and reset flags.
    expect(project.trackOrder).toHaveLength(3)
    const [bus, kick, keys] = project.trackOrder.map((id) => project.tracks[id])
    expect([bus.name, kick.name, keys.name]).toEqual(['Drum Bus', 'Kick', 'Keys'])
    expect(bus.id).not.toBe('bus')
    expect(kick.parentId).toBe(bus.id)
    expect(keys.parentId).toBeNull()
    expect(bus.soloed).toBe(false)
    expect(kick.muted).toBe(false)
    expect(kick.frozenAssetId).toBeNull()
    expect(kick.volume).toBeCloseTo(1.1)
    expect(keys.synth.cutoff).toBe(9)

    // Plugin chains follow their tracks; descriptors and blobs intact.
    const pluginList = Object.values(project.plugins)
    expect(pluginList).toHaveLength(2)
    const eq = pluginList.find((p) => p.descriptor.format === 'builtin')!
    const ext = pluginList.find((p) => p.descriptor.format === 'vst3')!
    expect(eq.trackId).toBe(kick.id)
    expect(eq.params.low).toBe(2)
    expect(ext.trackId).toBe(keys.id)
    expect(ext.enabled).toBe(false)
    expect(ext.stateBlob).toBe('b64chunk')
    expect(ext.params.mix).toBe(0.4)

    // Routes remapped onto the fresh plugin ids.
    const routeList = Object.values(project.routes)
    expect(routeList).toHaveLength(2)
    expect(routeList.find((r) => r.from === 'in')?.to).toBe(eq.id)
    expect(routeList.find((r) => r.to === 'out')?.from).toBe(eq.id)

    // Content never crosses: no clips, notes, files, chat, comments, automation.
    expect(Object.keys(project.clips)).toHaveLength(0)
    expect(Object.keys(project.notes)).toHaveLength(0)
    expect(Object.keys(project.files)).toHaveLength(0)
    expect(Object.keys(project.automation)).toHaveLength(0)
    expect(project.chat).toHaveLength(0)
  })

  test('instantiating twice mints disjoint ids', () => {
    const parsed = parseProjectTemplate(serializeProjectTemplate(sampleState(), 'T'))
    const a = projectFromTemplate(parsed, 'A', 1)
    const b = projectFromTemplate(parsed, 'B', 2)
    for (const id of a.trackOrder) expect(b.trackOrder).not.toContain(id)
    for (const id of Object.keys(a.plugins)) expect(id in b.plugins).toBe(false)
  })

  test('rejects non-templates and newer versions', () => {
    expect(() => parseProjectTemplate('not json')).toThrow(/corrupted/)
    expect(() => parseProjectTemplate('{"kind":"other"}')).toThrow(/Not a SuperDAW/)
    expect(() =>
      parseProjectTemplate('{"kind":"superdaw-project-template","formatVersion":999}')
    ).toThrow(/newer version/)
  })

  test('hostile fields clamp or drop instead of loading', () => {
    const doctored = JSON.stringify({
      kind: 'superdaw-project-template',
      formatVersion: 1,
      name: '',
      tempo: 9000,
      timeSignature: [0, 7],
      masterVolume: 99,
      settings: { loudnessTargetLufs: -999, bogus: true },
      tracks: [
        { id: 't1', kind: 'audio', name: 'Ok', volume: 50, pan: -9, parentId: 'missing' },
        { id: 't1', kind: 'audio', name: 'Duplicate id — dropped' },
        { kind: 'audio', name: 'No id — dropped' },
        { id: 't2', kind: 'alien', name: 'Bad kind — dropped' }
      ],
      plugins: [
        { id: 'p1', trackId: 't1', descriptor: { format: 'builtin', uid: 'superdaw.notreal', name: 'x', vendor: 'x', version: '1' } },
        { id: 'p2', trackId: 'ghost', descriptor: { format: 'vst3', uid: 'u', name: 'n', vendor: 'v', version: '1' } },
        { id: 'p3', trackId: 't1', descriptor: 'garbage' }
      ],
      routes: [
        { trackId: 't1', from: 'in', to: 'p3' }, // endpoint didn't survive
        { trackId: 'ghost', from: 'in', to: 'out' }
      ]
    })
    const parsed = parseProjectTemplate(doctored)
    expect(parsed.tempo).toBe(400)
    expect(parsed.timeSignature).toEqual([4, 4])
    expect(parsed.settings.loudnessTargetLufs).toBe(-36)
    expect(parsed.tracks).toHaveLength(1)
    expect(parsed.tracks[0].parentId).toBeNull() // parent wasn't a folder here
    expect(parsed.tracks[0].volume).toBeLessThanOrEqual(2.1) // clamped to MAX_GAIN
    expect(parsed.tracks[0].pan).toBe(-1)
    expect(parsed.plugins).toHaveLength(0)
    expect(parsed.routes).toHaveLength(0)

    const project = projectFromTemplate(parsed, 'Safe', 0)
    expect(project.trackOrder).toHaveLength(1)
    expect(Object.keys(project.plugins)).toHaveLength(0)
  })

  test('a woven folder cycle is broken at instantiation', () => {
    const cyclic = JSON.stringify({
      kind: 'superdaw-project-template',
      formatVersion: 1,
      name: 'Cycle',
      tempo: 120,
      timeSignature: [4, 4],
      masterVolume: 1,
      settings: {},
      tracks: [
        { id: 'a', kind: 'folder', name: 'A', parentId: 'b' },
        { id: 'b', kind: 'folder', name: 'B', parentId: 'a' }
      ],
      plugins: [],
      routes: []
    })
    const project = projectFromTemplate(parseProjectTemplate(cyclic), 'Safe', 0)
    const roots = project.trackOrder.filter((id) => project.tracks[id].parentId === null)
    expect(roots.length).toBeGreaterThan(0)
    // Every surviving parent chain terminates.
    for (const id of project.trackOrder) {
      const seen = new Set<string>()
      let current: string | null = id
      while (current !== null) {
        expect(seen.has(current)).toBe(false)
        seen.add(current)
        current = project.tracks[current]?.parentId ?? null
      }
    }
  })
})
