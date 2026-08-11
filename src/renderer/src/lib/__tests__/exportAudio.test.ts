import { describe as suite, afterEach, expect, test } from 'vitest'
import type { ProjectState, Track, TrackId } from '@core/model/types'
import { createEmptyProject } from '@core/model/types'
import { apply } from '@core/ops/apply'
import { builtinEffectDescriptor } from '@core/plugins/builtin'
import type { PluginDescriptor } from '@core/plugins/descriptor'
import { pluginRegistry } from '@audio/pluginRegistry'
import { encodeMp3, vst3BypassedTrackNames, vst3BypassWarning } from '../exportAudio'

/**
 * The encoder is third-party; these pin OUR wrapping of it — block
 * chunking, stereo/mono handling, and that the output is actually an MP3
 * bitstream rather than silence-sized garbage.
 */

function sine(seconds: number, sampleRate: number, freq = 440): Float32Array {
  const out = new Float32Array(Math.round(seconds * sampleRate))
  for (let i = 0; i < out.length; i++) {
    out[i] = 0.5 * Math.sin((2 * Math.PI * freq * i) / sampleRate)
  }
  return out
}

suite('encodeMp3', () => {
  test('produces a framed MP3 bitstream of plausible size', () => {
    const sampleRate = 44100
    const mp3 = encodeMp3([sine(1, sampleRate), sine(1, sampleRate, 660)], sampleRate)
    // MP3 frames start with an 11-bit sync run: 0xFF followed by 0xEx/0xFx.
    expect(mp3[0]).toBe(0xff)
    expect(mp3[1] & 0xe0).toBe(0xe0)
    // 192kbps ≈ 24 KB/s: a second of audio must be in that ballpark, far
    // from both zero and the ~176 KB raw PCM would be.
    expect(mp3.length).toBeGreaterThan(15_000)
    expect(mp3.length).toBeLessThan(40_000)
  })

  test('mono input duplicates into both channels rather than crashing', () => {
    const sampleRate = 44100
    const mp3 = encodeMp3([sine(0.25, sampleRate)], sampleRate)
    expect(mp3.length).toBeGreaterThan(3_000)
    expect(mp3[0]).toBe(0xff)
  })

  test('input not divisible by the 1152 block size still encodes fully', () => {
    const sampleRate = 44100
    const odd = sine(1.0001, sampleRate) // 44104 samples: 38 blocks + 328 leftover
    const mp3 = encodeMp3([odd, odd], sampleRate)
    expect(mp3.length).toBeGreaterThan(15_000)
  })
})

/**
 * The bypass warning is pure over state + registry: an "installed VST3"
 * is faked through setExternalIndex, which is exactly how the Electron
 * shell injects availability (no provider — status 'offline', not
 * 'local'). Builtins keep resolving against the real registry.
 */
suite('vst3BypassedTrackNames', () => {
  const VST: PluginDescriptor = {
    format: 'vst3',
    uid: 'ext1',
    name: 'Verb',
    vendor: 'Acme',
    version: '1'
  }

  afterEach(() => pluginRegistry.setExternalIndex(null))

  function track(id: string, name: string): Track {
    return {
      id,
      kind: 'audio',
      name,
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

  function withTrack(state: ProjectState, id: string, name: string): ProjectState {
    return apply(state, {
      type: 'track/create',
      track: track(id, name),
      index: 99,
      clips: [],
      automation: [],
      notes: [],
      plugins: []
    })
  }

  function withPlugin(
    state: ProjectState,
    id: string,
    trackId: TrackId,
    descriptor: PluginDescriptor
  ): ProjectState {
    return apply(state, {
      type: 'plugin/add',
      instance: { id, trackId, descriptor, enabled: true, rank: 1, params: {}, stateBlob: null }
    })
  }

  function installFakeVst3(): void {
    pluginRegistry.setExternalIndex((d) => d.format === 'vst3')
  }

  test('builtin-only tracks report nothing', () => {
    installFakeVst3()
    let s = withTrack(createEmptyProject('P'), 't1', 'Drums')
    s = withPlugin(s, 'fx1', 't1', builtinEffectDescriptor('reverb'))
    expect(vst3BypassedTrackNames(s)).toEqual({ freezable: [], graph: [] })
    expect(vst3BypassWarning(s)).toBeNull()
  })

  test('unfrozen linear VST3 is named with the freeze advice', () => {
    installFakeVst3()
    let s = withTrack(createEmptyProject('P'), 't1', 'Lead')
    s = withPlugin(s, 'fx1', 't1', VST)
    expect(vst3BypassedTrackNames(s)).toEqual({ freezable: ['Lead'], graph: [] })
    expect(vst3BypassWarning(s)).toBe('VST3 inserts bypassed on Lead (freeze to include them)')
  })

  test('frozen linear track is suppressed — the freeze baked the VST3 in', () => {
    installFakeVst3()
    let s = withTrack(createEmptyProject('P'), 't1', 'Lead')
    s = withPlugin(s, 'fx1', 't1', VST)
    s = apply(s, { type: 'track/freeze', trackId: 't1', assetId: 'frozen1' })
    expect(vst3BypassedTrackNames(s)).toEqual({ freezable: [], graph: [] })
    expect(vst3BypassWarning(s)).toBeNull()
  })

  test('unfrozen graph track is named WITHOUT freeze advice — freezing shorts it too', () => {
    installFakeVst3()
    let s = withTrack(createEmptyProject('P'), 't1', 'Bus')
    s = withPlugin(s, 'fx1', 't1', VST)
    s = apply(s, {
      type: 'route/addMany',
      routes: [
        { id: 'r1', trackId: 't1', from: 'in', to: 'fx1' },
        { id: 'r2', trackId: 't1', from: 'fx1', to: 'out' }
      ]
    })
    expect(vst3BypassedTrackNames(s)).toEqual({ freezable: [], graph: ['Bus'] })
    expect(vst3BypassWarning(s)).toBe('VST3 inserts in routing graphs are not rendered (Bus)')
  })

  test('frozen graph track stays named — the graph freeze fast path did not bake it', () => {
    installFakeVst3()
    let s = withTrack(createEmptyProject('P'), 't1', 'Bus')
    s = withPlugin(s, 'fx1', 't1', VST)
    s = apply(s, {
      type: 'route/addMany',
      routes: [
        { id: 'r1', trackId: 't1', from: 'in', to: 'fx1' },
        { id: 'r2', trackId: 't1', from: 'fx1', to: 'out' }
      ]
    })
    s = apply(s, { type: 'track/freeze', trackId: 't1', assetId: 'frozen1' })
    expect(vst3BypassedTrackNames(s)).toEqual({ freezable: [], graph: ['Bus'] })
  })

  test('a graph VST3 off every in→out path cannot be missing from the bounce', () => {
    installFakeVst3()
    let s = withTrack(createEmptyProject('P'), 't1', 'Bus')
    s = withPlugin(s, 'fx1', 't1', VST)
    // Wired from the input but never reaching the output: shorting it
    // changes nothing audible, so no warning.
    s = apply(s, {
      type: 'route/addMany',
      routes: [{ id: 'r1', trackId: 't1', from: 'in', to: 'fx1' }]
    })
    expect(vst3BypassedTrackNames(s)).toEqual({ freezable: [], graph: [] })
  })

  test('mixed linear and graph tracks fold into ONE notice string', () => {
    installFakeVst3()
    let s = withTrack(createEmptyProject('P'), 't1', 'Lead')
    s = withTrack(s, 't2', 'Bus')
    s = withPlugin(s, 'fx1', 't1', VST)
    s = withPlugin(s, 'fx2', 't2', VST)
    s = apply(s, {
      type: 'route/addMany',
      routes: [
        { id: 'r1', trackId: 't2', from: 'in', to: 'fx2' },
        { id: 'r2', trackId: 't2', from: 'fx2', to: 'out' }
      ]
    })
    expect(vst3BypassWarning(s)).toBe(
      'VST3 inserts bypassed on Lead (freeze to include them); ' +
        'VST3 inserts in routing graphs are not rendered (Bus)'
    )
  })

  test('without the external index (browser build) nothing is offline, nothing warns', () => {
    let s = withTrack(createEmptyProject('P'), 't1', 'Lead')
    s = withPlugin(s, 'fx1', 't1', VST)
    expect(vst3BypassedTrackNames(s)).toEqual({ freezable: [], graph: [] })
  })
})
