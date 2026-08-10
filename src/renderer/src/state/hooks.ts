import { useRef, useSyncExternalStore } from 'react'
import type { ProjectState } from '@core/model/types'
import type { ActivityEntry } from '@core/state/store'
import { projectStore } from './projectStore'

export function useProjectState(): ProjectState {
  return useSyncExternalStore(projectStore.subscribe, () => projectStore.state)
}

/**
 * Subscribe to a SLICE of the project state. The component re-renders only
 * when the selected value actually changes — an op that leaves the slice
 * untouched costs nothing. This is what keeps per-row components (track
 * headers, clips, lanes) quiet while unrelated edits stream through the
 * store, which at 100 tracks is the difference between 1 and 250 renders
 * per fader nudge.
 *
 * The selector must be pure. For array/object results pass an `isEqual`
 * (e.g. `arrayShallowEqual`) so an equivalent recomputation keeps the
 * previous identity and React bails out.
 */
export function useProjectSelector<T>(
  selector: (state: ProjectState) => T,
  isEqual: (a: T, b: T) => boolean = Object.is
): T {
  const cache = useRef<{
    state: ProjectState
    selector: (state: ProjectState) => T
    value: T
  } | null>(null)
  const getSnapshot = (): T => {
    const state = projectStore.state
    const cached = cache.current
    // Same document and same selector — the memoized value stands. The
    // selector identity check matters because inline selectors close over
    // props (a track id); a new closure must recompute.
    if (cached && cached.state === state && cached.selector === selector) return cached.value
    const value = selector(state)
    if (cached && isEqual(cached.value, value)) {
      cache.current = { state, selector, value: cached.value }
    } else {
      cache.current = { state, selector, value }
    }
    return cache.current.value
  }
  return useSyncExternalStore(projectStore.subscribe, getSnapshot)
}

/** Element-wise identity comparison, for selectors that build arrays. */
export function arrayShallowEqual<T>(a: readonly T[], b: readonly T[]): boolean {
  if (a === b) return true
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

export function useActivity(): readonly ActivityEntry[] {
  return useSyncExternalStore(projectStore.subscribe, () => projectStore.activity)
}

export function useCanUndo(): boolean {
  return useSyncExternalStore(projectStore.subscribe, () => projectStore.canUndo)
}

export function useCanRedo(): boolean {
  return useSyncExternalStore(projectStore.subscribe, () => projectStore.canRedo)
}
