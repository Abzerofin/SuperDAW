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
 * by construction. See docs/PROTOCOL.md for the sync model.
 *
 * The store holds THREE layers (collapsed when not in a session):
 *
 *   confirmed  state per the host's authoritative op order
 *   pending    own ops not yet confirmed (in flight, or offline backlog)
 *   displayed  confirmed + pending, what the UI renders
 *
 * Solo mode and host mode have no pending set: confirmed === displayed.
 * Client mode (a `SequencerLink` is attached) dispatches optimistically:
 * displayed advances at once, the op joins `pending` and goes to the host;
 * `receiveAuthoritative` later confirms it (or interleaves remote ops,
 * rebasing pending on top).
 */

export type OpSource = 'local' | 'remote' | 'history'

/**
 * A project's identity across saved copies. `projectId` is minted once at
 * creation and travels with every copy; `origin` is a snapshot from which
 * the op log replays. Offline copies of the same project can be merged by
 * replaying the union of their logs from the earliest origin (core/merge).
 */
export interface ProjectLineage {
  readonly projectId: string
  /** When `origin` was captured — merge picks the earliest-origin fork as base. */
  readonly originTime: number
  readonly origin: ProjectState
}

export function mintLineage(state: ProjectState): ProjectLineage {
  return { projectId: newId('prj'), originTime: Date.now(), origin: state }
}

/**
 * Op-log bounds: past the limit the oldest entries are folded into the
 * origin snapshot (origin + log always reproduces the document). Merging
 * two copies then needs their histories to overlap within this window —
 * generous enough that it only matters for very long-lived projects.
 */
const LOG_LIMIT = 20_000
const LOG_KEEP = 15_000

export interface ActivityEntry {
  readonly id: string
  readonly userId: string
  readonly time: number
  readonly text: string
}

export type OpListener = (envelope: OpEnvelope, source: OpSource) => void

/** Where a client session sends its locally-originated ops. */
export interface SequencerLink {
  sendLocalOp(envelope: OpEnvelope): void
}

interface HistoryEntry {
  forward: Operation
  inverse: Operation
  text: string
}

const ACTIVITY_LIMIT = 500

export class ProjectStore {
  private confirmed: ProjectState
  private displayed: ProjectState
  private pending: OpEnvelope[] = []
  private link: SequencerLink | null = null

  private undoStack: HistoryEntry[] = []
  private redoStack: HistoryEntry[] = []
  private activityLog: readonly ActivityEntry[] = []
  private stateListeners = new Set<() => void>()
  private opListeners = new Set<OpListener>()

  private lineageInfo: ProjectLineage
  private log: OpEnvelope[] = []
  private logIds = new Set<string>()

  constructor(
    initial: ProjectState,
    readonly userId: string
  ) {
    this.confirmed = initial
    this.displayed = initial
    this.lineageInfo = mintLineage(initial)
  }

  get state(): ProjectState {
    return this.displayed
  }

  get confirmedState(): ProjectState {
    return this.confirmed
  }

  get pendingOps(): readonly OpEnvelope[] {
    return this.pending
  }

  get activity(): readonly ActivityEntry[] {
    return this.activityLog
  }

  get lineage(): ProjectLineage {
    return this.lineageInfo
  }

  /** Every committed envelope since `lineage.origin`, in application order. */
  get opLog(): readonly OpEnvelope[] {
    return this.log
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

  // ---------- Session lifecycle (client mode) ----------

  /** Enter client mode: local ops become optimistic and flow to the host. */
  attachSession(link: SequencerLink): void {
    this.link = link
  }

  /**
   * Leave client mode. Whatever is displayed (including unconfirmed local
   * edits) is adopted as the local document — the project becomes a plain
   * local project again.
   */
  detachSession(): void {
    this.link = null
    this.confirmed = this.displayed
    this.pending = []
  }

  /**
   * Replace the entire document (opening a project file, or first join
   * snapshot). NOT an operation: history, activity, and pending reset
   * because they describe a document that no longer exists. Pass the
   * file's lineage + op log to keep the project's identity across copies;
   * omit them to start a fresh lineage (new/legacy projects).
   */
  loadProject(state: ProjectState, lineage?: ProjectLineage, log?: readonly OpEnvelope[]): void {
    this.confirmed = state
    this.displayed = state
    this.pending = []
    this.undoStack = []
    this.redoStack = []
    this.activityLog = []
    this.lineageInfo = lineage ?? mintLineage(state)
    this.log = log ? [...log] : []
    this.logIds = new Set(this.log.map((e) => e.id))
    this.emitState()
  }

  /**
   * Reconnect resync: adopt a fresh authoritative snapshot but KEEP local
   * history and pending edits — pending rebases on top and the session
   * will re-send it (ops are idempotent, so double-delivery is safe).
   */
  resetToSnapshot(state: ProjectState): void {
    this.confirmed = state
    this.rebase()
    this.emitState()
  }

  /**
   * An op arrived in authoritative order (client mode). Confirms our own
   * in-flight ops; interleaves everyone else's, rebasing pending on top.
   */
  receiveAuthoritative(envelope: OpEnvelope): void {
    const ownIndex = this.pending.findIndex((p) => p.id === envelope.id)
    const isOwn = ownIndex !== -1
    // Describe against pre-apply confirmed state so names resolve. A null
    // description (chat) stays out of the activity feed but still applies.
    const text = isOwn ? null : describe(this.confirmed, envelope.op)

    this.confirmed = apply(this.confirmed, envelope.op)
    if (isOwn) this.pending.splice(ownIndex, 1)
    this.rebase()
    this.appendLog(envelope) // own ops were logged at dispatch; dedupe skips them

    if (!isOwn) {
      // Own ops were logged optimistically at dispatch time.
      if (text) this.pushActivity(envelope.userId, text)
      for (const listener of this.opListeners) listener(envelope, 'remote')
    }
    this.emitState()
  }

  /**
   * The host acked one of our ops as a no-op (its target vanished, or it
   * was an idempotent re-send). Drop it from pending; the rebase removes
   * its optimistic effect if the target is gone.
   */
  confirmNoop(envelopeId: string): void {
    const index = this.pending.findIndex((p) => p.id === envelopeId)
    if (index === -1) return
    this.pending.splice(index, 1)
    this.rebase()
    this.emitState()
  }

  // ---------- Edits ----------

  /**
   * Apply an operation. Returns false if it was a no-op (e.g. it targeted
   * an entity that no longer exists). `source: 'remote'` is for a HOST
   * applying a client's op (clients receive remote ops via
   * `receiveAuthoritative` instead); pass the originating envelope id so
   * the origin peer can match the echo.
   */
  dispatch(
    op: Operation,
    source: OpSource = 'local',
    userId: string = this.userId,
    envelopeId?: string
  ): boolean {
    const next = apply(this.displayed, op)
    if (next === this.displayed) return false

    const text = describe(this.displayed, op)
    if (source === 'local') {
      const inverse = invert(this.displayed, op)
      if (inverse) {
        this.undoStack.push({ forward: op, inverse, text: text ?? op.type })
        this.redoStack = []
      }
    }
    this.commit(op, next, text, source, userId, envelopeId)
    return true
  }

  undo(): boolean {
    const entry = this.undoStack.pop()
    if (!entry) return false
    const next = apply(this.displayed, entry.inverse)
    this.redoStack.push(entry)
    this.commit(entry.inverse, next, `Undo · ${entry.text}`, 'history', this.userId)
    return true
  }

  redo(): boolean {
    const entry = this.redoStack.pop()
    if (!entry) return false
    const inverse = invert(this.displayed, entry.forward)
    const next = apply(this.displayed, entry.forward)
    if (inverse) this.undoStack.push({ ...entry, inverse })
    this.commit(entry.forward, next, `Redo · ${entry.text}`, 'history', this.userId)
    return true
  }

  // ---------- Internals ----------

  private commit(
    op: Operation,
    next: ProjectState,
    text: string | null,
    source: OpSource,
    userId: string,
    envelopeId?: string
  ): void {
    const envelope: OpEnvelope = {
      id: envelopeId ?? newId('op'),
      userId,
      time: Date.now(),
      op
    }

    this.displayed = next
    if (this.link !== null && source !== 'remote') {
      // Client mode: optimistic. Confirmed advances only via the host echo.
      this.pending.push(envelope)
      this.link.sendLocalOp(envelope)
    } else {
      // Solo/host mode: confirmed and displayed advance together.
      this.confirmed = apply(this.confirmed, op)
    }
    this.appendLog(envelope)

    if (text) this.pushActivity(userId, text)
    for (const listener of this.opListeners) listener(envelope, source)
    this.emitState()
  }

  private rebase(): void {
    let state = this.confirmed
    for (const p of this.pending) state = apply(state, p.op)
    this.displayed = state
  }

  /**
   * Append to the persistent op log (deduped by envelope id — an op can
   * arrive twice: optimistic dispatch then host echo, or an idempotent
   * re-send). Past LOG_LIMIT the oldest entries fold into the origin
   * snapshot so origin + log keeps reproducing the document.
   */
  private appendLog(envelope: OpEnvelope): void {
    if (this.logIds.has(envelope.id)) return
    this.logIds.add(envelope.id)
    this.log.push(envelope)
    if (this.log.length <= LOG_LIMIT) return

    const folded = this.log.splice(0, this.log.length - LOG_KEEP)
    let origin = this.lineageInfo.origin
    for (const old of folded) {
      origin = apply(origin, old.op)
      this.logIds.delete(old.id)
    }
    this.lineageInfo = {
      ...this.lineageInfo,
      origin,
      originTime: folded[folded.length - 1].time
    }
  }

  private pushActivity(userId: string, text: string): void {
    this.activityLog = [
      ...this.activityLog.slice(-(ACTIVITY_LIMIT - 1)),
      { id: newId('act'), userId, time: Date.now(), text }
    ]
  }

  private emitState(): void {
    for (const listener of this.stateListeners) listener()
  }
}
