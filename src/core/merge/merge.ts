import type { ProjectState } from '../model/types'
import type { OpEnvelope } from '../ops/operations'
import type { ProjectLineage } from '../state/store'
import { apply } from '../ops/apply'

/**
 * Offline merge of two copies of the SAME project (matching projectId).
 *
 * Both forks carry an origin snapshot plus the op log recorded since it
 * (see ProjectLineage). The merge takes the fork with the EARLIEST origin
 * as the base — its log covers the longest history — unions both logs
 * (deduped by envelope id: shared history appears in both), sorts the
 * union chronologically, and replays it through the ordinary reducer.
 *
 * Per-field last-write-wins falls out of that replay: one gesture is one
 * op, so whichever fork touched the volume most recently lands last and
 * sticks, independently of who last touched the pan. Structural conflicts
 * resolve by the reducer's convergence rule (ops whose targets no longer
 * exist are dropped, never thrown).
 *
 * The result is a normal project plus the merged lineage, so merges chain:
 * merge, keep editing, merge again later.
 */

export interface ProjectFork {
  readonly lineage: ProjectLineage
  readonly log: readonly OpEnvelope[]
}

export interface MergeResult {
  readonly state: ProjectState
  readonly lineage: ProjectLineage
  readonly log: OpEnvelope[]
  /** Ops that changed state during replay. */
  readonly applied: number
  /** Ops dropped by the reducer (superseded, or their target was gone). */
  readonly dropped: number
}

export function canMerge(a: ProjectFork, b: ProjectFork): boolean {
  return a.lineage.projectId === b.lineage.projectId
}

export function mergeForks(a: ProjectFork, b: ProjectFork): MergeResult {
  if (!canMerge(a, b)) {
    throw new Error('These files are not copies of the same project')
  }
  const base = a.lineage.originTime <= b.lineage.originTime ? a : b

  const seen = new Set<string>()
  const union: OpEnvelope[] = []
  for (const envelope of [...a.log, ...b.log]) {
    if (seen.has(envelope.id)) continue
    seen.add(envelope.id)
    union.push(envelope)
  }
  // Chronological replay; envelope id breaks timestamp ties so the merge
  // is deterministic regardless of argument order.
  union.sort((x, y) => x.time - y.time || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0))

  let state = base.lineage.origin
  let applied = 0
  let dropped = 0
  for (const envelope of union) {
    const next = apply(state, envelope.op)
    if (next === state) dropped++
    else applied++
    state = next
  }

  return { state, lineage: base.lineage, log: union, applied, dropped }
}
