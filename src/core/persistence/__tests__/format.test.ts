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
    track: { id: 't1', kind: 'audio', name: 'T', color: '#fff', muted: false, soloed: true },
    index: 0,
    clips: []
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
    }
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

  test('a v1 file missing a required section is rejected, not half-loaded', () => {
    const { files: _files, ...truncated } = sampleState()
    const text = JSON.stringify({ formatVersion: 1, state: truncated, assets: [] })
    expect(() => parseProjectJson(text)).toThrow(/corrupted/)
  })
})
