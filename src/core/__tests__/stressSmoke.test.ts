import { describe, expect, test } from 'vitest'
import { createEmptyProject } from '../model/types'
import { ProjectStore } from '../state/store'
import {
  generateStressProject,
  stressTestUndoRedo,
  stressTestDispatchThroughput,
  stressTestRouting,
  stressTestFolderNesting,
  stressTestAutomation,
  stressTestDensePianoRoll,
  stressTestStructuralStorm,
  stressTestRemoteDelivery,
  stressTestOpLogFold,
  stressTestPersistence,
  stateInvariantViolations,
  deepEqual,
  type ScenarioResult
} from '../stressTest'

/**
 * The store-only stress scenarios at reduced scale, asserting the
 * correctness invariants (convergence, undo-all-equals-baseline, fold
 * preserves state, referential integrity) so CI catches regressions.
 * Frame/playback probes are browser-only and deliberately absent here.
 */

function newStore(): ProjectStore {
  return new ProjectStore(createEmptyProject('Smoke'), 'user')
}

async function generatedStore(): Promise<ProjectStore> {
  const store = newStore()
  await generateStressProject(store, {
    trackCount: 12,
    effectsPerTrack: 3,
    clipsPerTrack: 2,
    notesPerClip: 10,
    quiet: true
  })
  return store
}

function expectPassed(result: ScenarioResult): void {
  const failed = result.assertions.filter((a) => !a.passed)
  expect(failed, JSON.stringify(failed, null, 2)).toEqual([])
  expect(result.passed).toBe(true)
}

describe('stress smoke (reduced scale)', () => {
  test('generation produces exactly what it claims, and a healthy document', async () => {
    const store = newStore()
    const metrics = await generateStressProject(store, {
      trackCount: 12,
      effectsPerTrack: 3,
      clipsPerTrack: 2,
      notesPerClip: 10,
      quiet: true
    })
    expect(metrics.verified.tracksInState).toBe(12)
    expect(metrics.verified.pluginsInState).toBe(36)
    expect(metrics.verified.clipsInState).toBe(24)
    expect(metrics.verified.notesInState).toBe(metrics.noteCount)
    expect(stateInvariantViolations(store.state)).toEqual([])
  })

  test('undoRedo counts real ops and returns exactly to baseline', async () => {
    const store = await generatedStore()
    const baseline = store.state
    const result = stressTestUndoRedo(store, { operations: 120, quiet: true })
    expectPassed(result)
    expect(result.counts.operationsCreated).toBe(120)
    expect(result.counts.undone).toBe(120)
    expect(result.counts.redone).toBe(120)
    // The scenario's own cleanup leaves the project as it found it.
    expect(deepEqual(store.state, baseline)).toBe(true)
  })

  test('dispatch throughput storm is all real changes', async () => {
    const store = await generatedStore()
    const result = stressTestDispatchThroughput(store, { operations: 300, quiet: true })
    expectPassed(result)
    expect(result.counts.changed).toBe(300)
  })

  test('routing DAG storm validates edges and keeps tracks live', () => {
    const store = newStore()
    const result = stressTestRouting(store, { tracks: 6, pluginsPerTrack: 6, quiet: true })
    expectPassed(result)
    expect(result.counts.invalidSkipped).toBeGreaterThan(0) // rejection paths exercised
  })

  test('deep folder nesting survives reparent/reorder storms without cycles', () => {
    const store = newStore()
    const result = stressTestFolderNesting(store, {
      trees: 3,
      depth: 8,
      reparentOps: 60,
      reorderOps: 60,
      quiet: true
    })
    expectPassed(result)
  })

  test('automation density: adds land, moves are last-write exact', () => {
    const store = newStore()
    const result = stressTestAutomation(store, { points: 900, moves: 300, quiet: true })
    expectPassed(result)
    expect(result.counts.added).toBe(900)
  })

  test('dense piano roll: 2000+ notes, moveMany storms, idempotent re-delivery', () => {
    const store = newStore()
    const result = stressTestDensePianoRoll(store, { notes: 2200, storms: 3, quiet: true })
    expectPassed(result)
    expect(result.counts.notesInClip).toBe(2200)
  })

  test('structural storm leaves a referentially intact document', async () => {
    const store = await generatedStore()
    const result = stressTestStructuralStorm(store, { iterations: 150, quiet: true })
    expectPassed(result)
    expect(stateInvariantViolations(store.state)).toEqual([])
  })

  test('remote double-delivery converges, pending rebases drain', () => {
    const result = stressTestRemoteDelivery({ ops: 400, quiet: true })
    expectPassed(result)
    expect(result.counts.scriptOps).toBeGreaterThanOrEqual(400)
  })

  test('op-log fold preserves the document (origin + log replays exactly)', () => {
    const result = stressTestOpLogFold({ quiet: true })
    expectPassed(result)
    expect(result.counts.logAfter).toBeLessThan(result.counts.logBefore)
  })

  test('persistence round-trips a generated project exactly', async () => {
    const store = await generatedStore()
    const result = stressTestPersistence(store, { quiet: true })
    expectPassed(result)
    expect(result.counts.logEntries).toBeGreaterThan(0)
  })
})
