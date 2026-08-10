import { useSyncExternalStore } from 'react'
import { PPQ, ticksPerBar, ticksPerBeat, type TimeSignature } from '@core/model/timebase'
import type { SnapChoice } from '@core/model/projectSettings'

/**
 * Timeline snap resolution — ephemeral per-user UI state. 'auto' keeps the
 * original zoom-dependent behavior; 'off' disables snapping entirely.
 * The resolution roster is core's SnapChoice: the project document stores a
 * DEFAULT grid (`settings.defaultGrid`) that seeds this store at load; live
 * switching stays per-user and syncs to no one.
 */
export type GridChoice = SnapChoice

export const GRID_CHOICES: readonly { value: GridChoice; label: string }[] = [
  { value: 'auto', label: 'Grid: Auto' },
  { value: 'bar', label: 'Grid: Bar' },
  { value: 'beat', label: 'Grid: Beat' },
  { value: '1/8', label: 'Grid: 1/8' },
  { value: '1/16', label: 'Grid: 1/16' },
  { value: 'off', label: 'Grid: Off' }
]

export function gridTicksFor(
  choice: GridChoice,
  sig: TimeSignature,
  pxPerBeat: number
): number {
  switch (choice) {
    case 'auto':
      return pxPerBeat >= 16 ? ticksPerBeat(sig) : ticksPerBar(sig)
    case 'bar':
      return ticksPerBar(sig)
    case 'beat':
      return ticksPerBeat(sig)
    case '1/8':
      return PPQ / 2
    case '1/16':
      return PPQ / 4
    case 'off':
      return 1
  }
}

class GridUiStore {
  choice: GridChoice = 'auto'
  private listeners = new Set<() => void>()

  set(choice: GridChoice): void {
    if (this.choice === choice) return
    this.choice = choice
    for (const listener of this.listeners) listener()
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
}

export const gridUi = new GridUiStore()

export function useGridChoice(): GridChoice {
  return useSyncExternalStore(gridUi.subscribe, () => gridUi.choice)
}
