/**
 * Intents sent TO the File Bay from outside it (the dock tab's context
 * menu): "import files here", "create a folder". The bay panel may not be
 * mounted yet when the intent fires — openPanel renders it on the next
 * commit — so a send with no subscriber is buffered and delivered on
 * subscribe, the same one-shot pattern as appShell's collab intent.
 * Ephemeral UI plumbing; never document state.
 */

export type BayIntent = 'import' | 'new-folder'

class BayUiStore {
  private pending: BayIntent | null = null
  private listeners = new Set<(intent: BayIntent) => void>()

  send(intent: BayIntent): void {
    if (this.listeners.size === 0) {
      this.pending = intent
      return
    }
    for (const listener of this.listeners) listener(intent)
  }

  subscribe = (listener: (intent: BayIntent) => void): (() => void) => {
    this.listeners.add(listener)
    if (this.pending !== null) {
      const intent = this.pending
      this.pending = null
      // After mount, not during render.
      queueMicrotask(() => {
        if (this.listeners.has(listener)) listener(intent)
      })
    }
    return () => this.listeners.delete(listener)
  }
}

export const bayUi = new BayUiStore()
