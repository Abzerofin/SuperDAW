import { useSyncExternalStore } from 'react'
import type { Clip, PluginInstance, ProjectState, Track } from '@core/model/types'
import { describe } from '@core/ops/describe'
import { projectStore } from './projectStore'

/**
 * Per-ITEM history: for every clip, track and insert, the states it moved
 * through this session, so one item can be wound back without touching
 * anything else (via a restore op — ordinary, undoable, synced).
 *
 * Deliberately cheap: entries hold REFERENCES into the store's immutable
 * past states (structural sharing — no copying), the set of changed items
 * per op is found by reference-diffing two adjacent states, and the whole
 * thing is ephemeral per-user session state — never in the document.
 */

export type HistoryKind = 'clip' | 'track' | 'plugin'

export interface ItemHistoryEntry {
  /** Wall-clock time the change landed. */
  readonly time: number
  /** Activity-feed text of the op that caused it (or a fallback). */
  readonly label: string
  /** The item as it was BEFORE the change. */
  readonly snapshot: Clip | Track | PluginInstance
}

const MAX_ENTRIES_PER_ITEM = 30

class ItemHistoryStore {
  private entries = new Map<string, ItemHistoryEntry[]>()
  private lastState: ProjectState = projectStore.state
  /** Bumped per op — how the swap detector tells ops from loadProject. */
  private opSerial = 0
  private version = 0
  private listeners = new Set<() => void>()

  constructor() {
    projectStore.onOperation((envelope) => {
      this.opSerial++
      const prev = this.lastState
      const next = projectStore.state
      this.lastState = next
      if (prev === next) return
      const label = describe(prev, envelope.op) ?? envelope.op.type
      const time = Date.now()
      let changed = false
      // Reference-diff each record: immutable updates mean an untouched
      // item keeps its exact object identity.
      for (const [id, clip] of Object.entries(prev.clips)) {
        if (next.clips[id] !== undefined && next.clips[id] !== clip) {
          this.push(`clip:${id}`, { time, label, snapshot: clip })
          changed = true
        }
      }
      for (const [id, track] of Object.entries(prev.tracks)) {
        if (next.tracks[id] !== undefined && next.tracks[id] !== track) {
          this.push(`track:${id}`, { time, label, snapshot: track })
          changed = true
        }
      }
      for (const [id, instance] of Object.entries(prev.plugins)) {
        if (next.plugins[id] !== undefined && next.plugins[id] !== instance) {
          this.push(`plugin:${id}`, { time, label, snapshot: instance })
          changed = true
        }
      }
      if (changed) this.emit()
    })
    // loadProject swaps the document without an op — a state change no op
    // accounts for means a different project is in front of us and every
    // recorded past belongs to the old one. The check is deferred to a
    // microtask because subscriber order vs. the op listener is not
    // guaranteed within one dispatch; by microtask time the op listener
    // (synchronous in dispatch) has definitely run if there was one.
    projectStore.subscribe(() => {
      const seen = this.opSerial
      queueMicrotask(() => {
        if (this.opSerial !== seen) return // an op explains this change
        if (projectStore.state !== this.lastState) {
          this.lastState = projectStore.state
          if (this.entries.size > 0) {
            this.entries.clear()
            this.emit()
          }
        }
      })
    })
  }

  private push(key: string, entry: ItemHistoryEntry): void {
    let list = this.entries.get(key)
    if (!list) this.entries.set(key, (list = []))
    list.push(entry)
    if (list.length > MAX_ENTRIES_PER_ITEM) list.shift()
  }

  /** Newest first. */
  historyOf(kind: HistoryKind, id: string): readonly ItemHistoryEntry[] {
    return [...(this.entries.get(`${kind}:${id}`) ?? [])].reverse()
  }

  /** Wind ONE item back to a recorded state — a single ordinary op. */
  restore(kind: HistoryKind, id: string, entry: ItemHistoryEntry): void {
    if (kind === 'clip') {
      projectStore.dispatch({ type: 'clip/restore', clipId: id, clip: entry.snapshot as Clip })
    } else if (kind === 'track') {
      const track = entry.snapshot as Track
      projectStore.dispatch({
        type: 'track/restore',
        trackId: id,
        track: {
          name: track.name,
          color: track.color,
          muted: track.muted,
          soloed: track.soloed,
          volume: track.volume,
          pan: track.pan,
          synth: track.synth
        }
      })
    } else {
      const instance = entry.snapshot as PluginInstance
      projectStore.dispatch({
        type: 'plugin/restore',
        instanceId: id,
        params: { ...instance.params },
        enabled: instance.enabled,
        stateBlob: instance.stateBlob
      })
    }
  }

  getVersion = (): number => this.version

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private emit(): void {
    this.version++
    for (const listener of this.listeners) listener()
  }
}

export const itemHistory = new ItemHistoryStore()

export function useItemHistory(): ItemHistoryStore {
  useSyncExternalStore(itemHistory.subscribe, itemHistory.getVersion)
  return itemHistory
}
