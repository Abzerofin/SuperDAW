import { useSyncExternalStore } from 'react'
import type { ClipId } from '@core/model/types'
import { panels } from './panels'

/** Which MIDI clip the step sequencer is editing (ephemeral, per-user). */
class StepSeqUiStore {
  clipId: ClipId | null = null

  private version = 0
  private listeners = new Set<() => void>()

  open(clipId: ClipId): void {
    this.clipId = clipId
    panels.openPanel('steps')
    this.emit()
  }

  close(): void {
    if (this.clipId === null) return
    this.clipId = null
    panels.closePanel('steps')
    this.emit()
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

export const stepSeqUi = new StepSeqUiStore()

export function useStepSeqUi(): StepSeqUiStore {
  useSyncExternalStore(stepSeqUi.subscribe, stepSeqUi.getVersion)
  return stepSeqUi
}
