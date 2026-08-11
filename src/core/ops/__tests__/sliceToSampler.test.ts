import { describe, expect, test } from 'vitest'
import { createEmptyProject } from '../../model/types'
import { INSTRUMENT_KINDS, MAX_SLICES, SLICE_BASE_PITCH } from '../../model/effects'
import { sliceRegions } from '../../model/slices'
import { apply } from '../apply'
import { invert } from '../invert'
import { buildSliceToSamplerOp } from '../sliceToSampler'

const asset = { id: 'ast_break', name: 'Amen', seconds: 2 }

describe('sliceRegions', () => {
  test('covers the material contiguously, leading region included', () => {
    const regions = sliceRegions([0.5, 1.0, 1.5], 2)
    expect(regions).toEqual([
      { startSec: 0, endSec: 0.5 },
      { startSec: 0.5, endSec: 1.0 },
      { startSec: 1.0, endSec: 1.5 },
      { startSec: 1.5, endSec: 2 }
    ])
  })

  test('a first onset at the very start does not create a junk lead slice', () => {
    const regions = sliceRegions([0.01, 1], 2)
    expect(regions).toHaveLength(2)
    expect(regions[0].startSec).toBe(0.01)
  })

  test('drops out-of-range onsets, collapses doubles, caps at MAX_SLICES', () => {
    const many = Array.from({ length: 300 }, (_, i) => i * 0.01)
    expect(sliceRegions(many, 3).length).toBe(MAX_SLICES)
    expect(sliceRegions([-1, 0.5, 0.5001, 99], 2)).toEqual([
      { startSec: 0, endSec: 0.5 },
      { startSec: 0.5, endSec: 2 }
    ])
  })
})

describe('buildSliceToSamplerOp', () => {
  test('materializes a sliced-sampler track whose notes replay the groove', () => {
    const state = createEmptyProject('T') // 120 bpm, PPQ 960: 1 s = 1920 ticks
    const op = buildSliceToSamplerOp(state, asset, [0.5, 1.0, 1.5], {
      index: 0,
      color: '#e06c75'
    })
    expect(op).not.toBeNull()
    if (op?.type !== 'track/create') throw new Error('expected track/create')
    expect(op.track.kind).toBe('midi')
    expect(op.track.samplerAssetId).toBe('ast_break')
    expect(op.track.synth.instrument).toBe(INSTRUMENT_KINDS.indexOf('sampler'))
    expect(op.track.synth.smpMode).toBe(1)
    expect(op.clips).toHaveLength(1)
    expect(op.clips[0].duration).toBe(3840) // 2 s = 3840 ticks = exactly one bar
    expect(op.notes.map((n) => n.pitch)).toEqual(
      [0, 1, 2, 3].map((i) => SLICE_BASE_PITCH + i)
    )
    expect(op.notes.map((n) => n.start)).toEqual([0, 960, 1920, 2880])
    expect(op.notes[3].duration).toBe(960) // last slice runs to the asset end
  })

  test('applies through the ordinary reducer and one undo removes everything', () => {
    const before = createEmptyProject('T')
    const op = buildSliceToSamplerOp(before, asset, [0.5, 1.0], { index: 0, color: '#fff' })!
    const after = apply(before, op)
    expect(Object.keys(after.tracks)).toHaveLength(1)
    expect(Object.keys(after.notes)).toHaveLength(3)
    expect(apply(after, invert(before, op)!)).toEqual(before)
  })

  test('fewer than two slices builds nothing', () => {
    const state = createEmptyProject('T')
    expect(buildSliceToSamplerOp(state, asset, [], { index: 0, color: '#fff' })).toBeNull()
    expect(buildSliceToSamplerOp(state, { ...asset, seconds: 0 }, [1], { index: 0, color: '#fff' })).toBeNull()
  })
})
