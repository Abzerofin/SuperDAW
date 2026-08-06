import { useSyncExternalStore } from 'react'

/**
 * Top-level shell state: whether the user is on the home screen (the
 * primary project launcher) or in the editor. Ephemeral per-user UI state
 * — never part of any document. The app boots to home.
 */
class AppShellStore {
  view: 'home' | 'project' = 'home'
  /** A project is loaded in memory ("Return to Home" keeps it open). */
  projectOpen = false
  /** One-shot: open the Collab join panel on entering the project view. */
  private collabIntent = false

  private version = 0
  private listeners = new Set<() => void>()

  enterProject(opts?: { collab?: boolean }): void {
    this.view = 'project'
    this.projectOpen = true
    this.collabIntent = opts?.collab ?? false
    this.emit()
  }

  /** True exactly once after enterProject({collab: true}). */
  consumeCollabIntent(): boolean {
    const intent = this.collabIntent
    this.collabIntent = false
    return intent
  }

  /** Back to the launcher; the project stays loaded. */
  goHome(): void {
    this.view = 'home'
    this.emit()
  }

  /** The document was discarded (Close Project). */
  markProjectClosed(): void {
    this.projectOpen = false
    this.view = 'home'
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

export const appShell = new AppShellStore()

export function useAppShell(): AppShellStore {
  useSyncExternalStore(appShell.subscribe, appShell.getVersion)
  return appShell
}
