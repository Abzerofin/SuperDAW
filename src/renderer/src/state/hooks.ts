import { useSyncExternalStore } from 'react'
import type { ProjectState } from '@core/model/types'
import type { ActivityEntry } from '@core/state/store'
import { projectStore } from './projectStore'

export function useProjectState(): ProjectState {
  return useSyncExternalStore(projectStore.subscribe, () => projectStore.state)
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
