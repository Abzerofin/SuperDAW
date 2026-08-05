import { useSyncExternalStore } from 'react'
import type { CommentAnchor } from '@core/model/types'

/** Which comment thread popover is open (ephemeral, per-user). */
class CommentUiStore {
  anchor: CommentAnchor | null = null

  private version = 0
  private listeners = new Set<() => void>()

  open(anchor: CommentAnchor): void {
    this.anchor = anchor
    this.emit()
  }

  close(): void {
    if (this.anchor === null) return
    this.anchor = null
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

export const commentUi = new CommentUiStore()

export function useCommentUi(): CommentUiStore {
  useSyncExternalStore(commentUi.subscribe, commentUi.getVersion)
  return commentUi
}
