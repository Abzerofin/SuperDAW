import { describe as suite, afterEach, expect, test } from 'vitest'
import { unzipSync } from 'fflate'
import type { ProjectState, Track, TrackId, TrackKind } from '@core/model/types'
import { createEmptyProject, MASTER_BUS_ID } from '@core/model/types'
import { apply } from '@core/ops/apply'
import { builtinEffectDescriptor } from '@core/plugins/builtin'
import type { PluginDescriptor } from '@core/plugins/descriptor'
import { pluginRegistry } from '@audio/pluginRegistry'
import {
  encodeMp3,
  packStemsZip,
  sanitizeStemFileName,
  stemTrackIds,
  uniqueStemFileNames,
  vst3BypassedTrackNames,
  vst3BypassWarning
} from '../exportAudio'

/**
 * The encoder is third-party; these pin OUR wrapping of it â€” block
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
    // 192kbps â‰ˆ 24 KB/s: a second of audio must be in that ballpark, far
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
 * shell injects availability (no provider â€” status 'offline', not
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
    expect(vst3BypassedTrackNames(s)).toEqual({ freezable: [], graph: [], master: false })
    expect(vst3BypassWarning(s)).toBeNull()
  })

  test('unfrozen linear VST3 is named with the freeze advice', () => {
    installFakeVst3()
    let s = withTrack(createEmptyProject('P'), 't1', 'Lead')
    s = withPlugin(s, 'fx1', 't1', VST)
    expect(vst3BypassedTrackNames(s)).toEqual({ freezable: ['Lead'], graph: [], master: false })
    expect(vst3BypassWarning(s)).toBe('VST3 inserts bypassed on Lead (freeze to include them)')
  })

  test('frozen linear track is suppressed â€” the freeze baked the VST3 in', () => {
    installFakeVst3()
    let s = withTrack(createEmptyProject('P'), 't1', 'Lead')
    s = withPlugin(s, 'fx1', 't1', VST)
    s = apply(s, { type: 'track/freeze', trackId: 't1', assetId: 'frozen1' })
    expect(vst3BypassedTrackNames(s)).toEqual({ freezable: [], graph: [], master: false })
    expect(vst3BypassWarning(s)).toBeNull()
  })

  test('unfrozen graph track is named WITHOUT freeze advice â€” freezing shorts it too', () => {
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
    expect(vst3BypassedTrackNames(s)).toEqual({ freezable: [], graph: ['Bus'], master: false })
    expect(vst3BypassWarning(s)).toBe('VST3 inserts in routing graphs are not rendered (Bus)')
  })

  test('frozen graph track stays named â€” the graph freeze fast path did not bake it', () => {
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
    expect(vst3BypassedTrackNames(s)).toEqual({ freezable: [], graph: ['Bus'], master: false })
  })

  test('a graph VST3 off every inâ†’out path cannot be missing from the bounce', () => {
    installFakeVst3()
    let s = withTrack(createEmptyProject('P'), 't1', 'Bus')
    s = withPlugin(s, 'fx1', 't1', VST)
    // Wired from the input but never reaching the output: shorting it
    // changes nothing audible, so no warning.
    s = apply(s, {
      type: 'route/addMany',
      routes: [{ id: 'r1', trackId: 't1', from: 'in', to: 'fx1' }]
    })
    expect(vst3BypassedTrackNames(s)).toEqual({ freezable: [], graph: [], master: false })
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
    expect(vst3BypassedTrackNames(s)).toEqual({ freezable: [], graph: [], master: false })
  })

  test('an enabled VST3 on the master bus is reported — no freeze exists there', () => {
    installFakeVst3()
    let s = withTrack(createEmptyProject('P'), 't1', 'Lead')
    s = withPlugin(s, 'mfx', MASTER_BUS_ID, VST)
    expect(vst3BypassedTrackNames(s)).toEqual({ freezable: [], graph: [], master: true })
    expect(vst3BypassWarning(s)).toBe('VST3 inserts on the Master bus are bypassed in bounces')
  })
})

/**
 * The stem set is pure over state: which tracks earn a file when "Export
 * stems…" runs. Rendering itself (OfflineAudioContext) is untestable here;
 * these pin the selection rule the render loop iterates.
 */
suite('stemTrackIds', () => {
  function track(id: string, overrides: Partial<Track> = {}): Track {
    return {
      id,
      kind: 'audio' as TrackKind,
      name: id,
      color: '#5b8def',
      muted: false,
      soloed: false,
      parentId: null,
      frozenAssetId: null,
      volume: 1,
      pan: 0,
      synth: {},
      ...overrides
    }
  }

  function project(...tracks: Track[]): ProjectState {
    let s = createEmptyProject('P')
    for (const t of tracks) {
      s = apply(s, {
        type: 'track/create',
        track: t,
        index: 99,
        clips: [],
        automation: [],
        notes: [],
        plugins: []
      })
    }
    return s
  }

  test('every audible non-folder track, in trackOrder', () => {
    const s = project(track('drums'), track('bass'), track('keys', { kind: 'midi' }))
    expect(stemTrackIds(s)).toEqual(['drums', 'bass', 'keys'])
  })

  test('folder buses are excluded — their audio is the sum of their children', () => {
    const s = project(track('bus', { kind: 'folder' }), track('kick', { parentId: 'bus' }))
    expect(stemTrackIds(s)).toEqual(['kick'])
  })

  test('muted tracks are excluded', () => {
    const s = project(track('drums'), track('bass', { muted: true }))
    expect(stemTrackIds(s)).toEqual(['drums'])
  })

  test('an active solo elsewhere silences the rest of the set', () => {
    const s = project(track('drums', { soloed: true }), track('bass'))
    expect(stemTrackIds(s)).toEqual(['drums'])
  })

  test('children of a muted folder are excluded — the bus fader is closed', () => {
    const s = project(
      track('bus', { kind: 'folder', muted: true }),
      track('kick', { parentId: 'bus' }),
      track('bass')
    )
    expect(stemTrackIds(s)).toEqual(['bass'])
  })
})

suite('sanitizeStemFileName', () => {
  test('passes ordinary names through untouched', () => {
    expect(sanitizeStemFileName('Drums')).toBe('Drums')
    expect(sanitizeStemFileName('Lead Synth 2')).toBe('Lead Synth 2')
  })

  test('collapses path separators and Windows-reserved punctuation', () => {
    expect(sanitizeStemFileName('a/b\\c:d*e?f"g<h>i|j')).toBe('a_b_c_d_e_f_g_h_i_j')
  })

  test('strips control characters', () => {
    expect(sanitizeStemFileName('Dr\tums\n')).toBe('Dr_ums')
  })

  test('trims trailing dots and spaces (Windows drops them silently)', () => {
    expect(sanitizeStemFileName('Drums... ')).toBe('Drums')
  })

  test('empty and all-junk names fall back to Track', () => {
    expect(sanitizeStemFileName('')).toBe('Track')
    expect(sanitizeStemFileName('   ')).toBe('Track')
    expect(sanitizeStemFileName('...')).toBe('Track')
  })

  test('reserved device names are defused', () => {
    expect(sanitizeStemFileName('CON')).toBe('_CON')
    expect(sanitizeStemFileName('nul')).toBe('_nul')
    expect(sanitizeStemFileName('COM3')).toBe('_COM3')
    expect(sanitizeStemFileName('Console')).toBe('Console') // only exact matches
  })

  test('keeps non-ASCII letters — only hostile characters are replaced', () => {
    expect(sanitizeStemFileName('Пиано / Ambienté')).toBe('Пиано _ Ambienté')
  })
})

suite('uniqueStemFileNames', () => {
  test('unique names pass through unchanged', () => {
    expect(uniqueStemFileNames(['Drums', 'Bass'])).toEqual(['Drums', 'Bass'])
  })

  test('collisions count up: Drums, Drums 2, Drums 3', () => {
    expect(uniqueStemFileNames(['Drums', 'Drums', 'Drums'])).toEqual([
      'Drums',
      'Drums 2',
      'Drums 3'
    ])
  })

  test('case-insensitive — the target filesystems are', () => {
    expect(uniqueStemFileNames(['Drums', 'DRUMS'])).toEqual(['Drums', 'DRUMS 2'])
  })

  test('a suffixed name colliding with a real name keeps counting', () => {
    expect(uniqueStemFileNames(['Drums', 'Drums', 'Drums 2'])).toEqual([
      'Drums',
      'Drums 2',
      'Drums 2 2'
    ])
  })
})

suite('packStemsZip', () => {
  test('round-trips every stem byte-exactly (browser fallback packaging)', async () => {
    const files = {
      'Drums.wav': new Uint8Array([1, 2, 3, 4]),
      'Bass.wav': new Uint8Array([5, 6, 7])
    }
    const zipped = await packStemsZip(files)
    // A ZIP starts with the local-file-header signature PK\x03\x04.
    expect([...zipped.slice(0, 2)]).toEqual([0x50, 0x4b])
    const unzipped = unzipSync(zipped)
    expect(Object.keys(unzipped).sort()).toEqual(['Bass.wav', 'Drums.wav'])
    expect([...unzipped['Drums.wav']]).toEqual([1, 2, 3, 4])
    expect([...unzipped['Bass.wav']]).toEqual([5, 6, 7])
  })
})
