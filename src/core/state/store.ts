import type { ProjectState } from '../model/types'
import type { Operation, OpEnvelope } from '../ops/operations'
import { apply } from '../ops/apply'
import { invert } from '../ops/invert'
import { describe } from '../ops/describe'
import { newId } from '../model/ids'

/**
 * The single mutation pipeline for a project.
 *
 * Every edit — local UI action, remote collaborator op, undo, redo — flows
 * through this store. That single path is what makes the DAW collaborative
 * by construction:
 *
 *   - local ops are recorded for undo and (later) broadcast to peers
 *   - remote ops apply through the exact same reducer, so peers converge
 *   - the activity feed is a byproduct of the op stream, not separate logic
 *
 * UI-only, ephemeral state (drag previews, scroll, selection) intentionally
 * lives outside this store: it is per-user and never synchronized as ops.
 */

export type OpSource = 'local' | 'remote' | 'history'

export interface ActivityEntry {
  readonly id: string
  readonly userId: string
  readonly time: number
  readonly text: string
}

export type OpListener = (envelope: OpEnvelope, source: OpSource) => void

interface HistoryEntry {
  forward: Operation
  inverse: Operation
  text: string
}

const ACTIVITY_LIMIT = 500

export class ProjectStore {
  private current: ProjectState
  private undoStack: HistoryEntry[] = []
  private redoStack: HistoryEntry[] = []
  private activityLog: readonly ActivityEntry[] = []
  private stateListeners = new Set<() => void>()
  private opListeners = new Set<OpListener>()

  constructor(
    initial: ProjectState,
    readonly userId: string
  ) {
    this.current = initial
  }

  get state(): ProjectState {
    return this.current
  }

  get activity(): readonly ActivityEntry[] {
    return this.activityLog
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0
  }

  subscribe = (listener: () => void): (() => void) => {
    this.stateListeners.add(listener)
    return () => this.stateListeners.delete(listener)
  }

  /** Tap into the op stream (network layer, persistence, etc.). */
  onOperation(listener: OpListener): () => void {
    this.opListeners.add(listener)
    return () => this.opListeners.delete(listener)
  }

  /**
   * Apply an operation. Returns false if it was a no-op (e.g. it targeted
   * an entity that no longer exists).
   */
  dispatch(op: Operation, source: OpSource = 'local', userId = this.userId): boolean {
    const next = apply(this.current, op)
    if (next === this.current) return false

    const text = describe(this.current, op)
    if (source === 'local') {
      const inverse = invert(this.current, op)
      if (inverse) {
        this.undoStack.push({ forward: op, inverse, text })
        this.redoStack = []
      }
    }
    this.commit(op, next, text, source, userId)
    return true
  }

  undo(): boolean {
    const entry = this.undoStack.pop()
    if (!entry) return false
    const next = apply(this.current, entry.inverse)
    this.redoStack.push(entry)
    this.commit(entry.inverse, next, `Undo · ${entry.text}`, 'history', this.userId)
    return true
  }

  redo(): boolean {
    const entry = this.redoStack.pop()
    if (!entry) return false
    const inverse = invert(this.current, entry.forward)
    const next = apply(this.current, entry.forward)
    if (inverse) this.undoStack.push({ ...entry, inverse })
    this.commit(entry.forward, next, `Redo · ${entry.text}`, 'history', this.userId)
    return true
  }

  private commit(
    op: Operation,
    next: ProjectState,
    text: string,
    source: OpSource,
    userId: string
  ): void {
    this.current = next
    this.activityLog = [
      ...this.activityLog.slice(-(ACTIVITY_LIMIT - 1)),
      { id: newId('act'), userId, time: Date.now(), text }
    ]
    const envelope: OpEnvelope = { id: newId('op'), userId, time: Date.now(), op }
    for (const listener of this.opListeners) listener(envelope, source)
    for (const listener of this.stateListeners) listener()
  }
}
