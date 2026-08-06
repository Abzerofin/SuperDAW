import { useSyncExternalStore } from 'react'
import type { ProjectState } from '@core/model/types'
import { referencedAssetIds } from '@core/persistence/format'
import { pluginManifest } from '@core/plugins/manifest'
import { projectEndTicks } from '@audio/render'
import { pluginRegistry } from '@audio/pluginRegistry'
import { assetStore } from './audioInstance'
import { appStorageGet, appStorageSet } from './appStorage'

/**
 * The recent-projects index that powers the home screen. Metadata is
 * captured from the already-loaded ProjectState every time a project is
 * saved or opened — the index never reads project files itself. Purely
 * local app state (see appStorage); no accounts, no cloud.
 */

export interface RecentProject {
  /** Absolute path on disk; null in the browser build (no stable paths). */
  readonly path: string | null
  readonly name: string
  /** ms epoch of the last open/save. */
  readonly lastOpened: number
  /** ms epoch the project was created; 0 = unknown (older files). */
  readonly createdAt: number
  readonly tempo: number
  readonly timeSignature: readonly [number, number]
  /** Timeline end in ticks (0 = empty project). */
  readonly durationTicks: number
  readonly trackCount: number
  /** Distinct plugins the project uses. */
  readonly pluginCount: number
  /** Referenced assets that were absent locally at the last open/save. */
  readonly missingAssets: number
  /** Plugins that were unavailable on THIS machine at the last open/save. */
  readonly missingPlugins: number
}

const STORAGE_KEY = 'recentProjects'
const LIMIT = 30

/** Entries are keyed by path; browser entries (no path) fall back to name. */
function keyOf(entry: Pick<RecentProject, 'path' | 'name'>): string {
  return entry.path ?? `name:${entry.name}`
}

class RecentProjectsStore {
  private entries: RecentProject[] = []
  private loaded = false
  private version = 0
  private listeners = new Set<() => void>()

  constructor() {
    void this.load()
  }

  get list(): readonly RecentProject[] {
    return this.entries
  }

  private async load(): Promise<void> {
    const stored = await appStorageGet<RecentProject[]>(STORAGE_KEY)
    if (Array.isArray(stored)) {
      // Later records win over whatever raced in before the load finished.
      const merged = new Map(stored.map((e) => [keyOf(e), e]))
      for (const e of this.entries) merged.set(keyOf(e), e)
      this.entries = [...merged.values()].sort((a, b) => b.lastOpened - a.lastOpened)
    }
    this.loaded = true
    this.emit()
  }

  /** Index the given project — called on every successful save and open. */
  record(state: ProjectState, path: string | null): void {
    const manifest = pluginManifest(state)
    const entry: RecentProject = {
      path,
      name: state.name.trim() || 'Untitled',
      lastOpened: Date.now(),
      createdAt: state.createdAt,
      tempo: state.tempo,
      timeSignature: [state.timeSignature[0], state.timeSignature[1]],
      durationTicks: projectEndTicks(state),
      trackCount: state.trackOrder.length,
      pluginCount: manifest.length,
      missingAssets: [...referencedAssetIds(state)].filter((id) => !assetStore.get(id)).length,
      missingPlugins: manifest.filter((e) => pluginRegistry.status(e.descriptor) !== 'local').length
    }
    this.entries = [entry, ...this.entries.filter((e) => keyOf(e) !== keyOf(entry))].slice(0, LIMIT)
    this.persist()
    this.emit()
  }

  /** Drop an entry (file deleted or moved). */
  remove(entry: RecentProject): void {
    this.entries = this.entries.filter((e) => keyOf(e) !== keyOf(entry))
    this.persist()
    this.emit()
  }

  private persist(): void {
    if (!this.loaded) return // never clobber the stored list before reading it
    void appStorageSet(STORAGE_KEY, this.entries)
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getVersion = (): number => this.version

  private emit(): void {
    this.version++
    for (const listener of this.listeners) listener()
  }
}

export const recentProjects = new RecentProjectsStore()

export function useRecentProjects(): readonly RecentProject[] {
  useSyncExternalStore(recentProjects.subscribe, recentProjects.getVersion)
  return recentProjects.list
}
