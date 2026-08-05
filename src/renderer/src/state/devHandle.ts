import { projectStore } from './projectStore'
import { transport } from './transport'
import { collab } from './collab'
import { recording } from './recording'
import { panels } from './panels'
import { audioEngine, assetStore } from './audioInstance'

/**
 * Dev-only debug handle: the LIVE singletons, immune to module-graph
 * duplication when tools dynamically import modules by URL. Loaded from
 * main.tsx in dev builds only.
 */
if (import.meta.env.DEV) {
  ;(window as unknown as Record<string, unknown>).__superdaw = {
    projectStore,
    transport,
    collab,
    recording,
    panels,
    audioEngine,
    assetStore
  }
}

export {}
