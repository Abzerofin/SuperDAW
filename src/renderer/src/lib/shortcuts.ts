import { useEffect } from 'react'
import { projectStore } from '@/state/projectStore'
import { transport } from '@/state/transport'
import { selection } from '@/state/selection'
import { commentUi } from '@/state/commentUi'
import { openProject, saveProject } from './projectFile'

/** App-wide keyboard shortcuts. Inactive while a text field has focus. */
export function useGlobalShortcuts(): void {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      const target = e.target as HTMLElement
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
        return

      if (e.code === 'Space') {
        e.preventDefault()
        transport.toggle()
        return
      }

      const mod = e.ctrlKey || e.metaKey
      if (mod && e.key.toLowerCase() === 's') {
        e.preventDefault()
        void saveProject(e.shiftKey) // Ctrl+Shift+S = Save As
        return
      }
      if (mod && e.key.toLowerCase() === 'o') {
        e.preventDefault()
        void openProject()
        return
      }
      if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault()
        if (e.shiftKey) projectStore.redo()
        else projectStore.undo()
        return
      }
      if (mod && e.key.toLowerCase() === 'y') {
        e.preventDefault()
        projectStore.redo()
        return
      }

      if (e.key.toLowerCase() === 'c' && !mod && !e.altKey) {
        const clipId = selection.selectedClipId
        if (clipId) {
          e.preventDefault()
          commentUi.open({ kind: 'clip', id: clipId })
        }
        return
      }

      if (e.key === 'Delete' || e.key === 'Backspace') {
        const clipId = selection.selectedClipId
        if (clipId) {
          selection.select(null)
          projectStore.dispatch({ type: 'clip/delete', clipId })
        }
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])
}
