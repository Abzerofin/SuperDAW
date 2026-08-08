import { useEffect } from 'react'
import { buildDuplicateTrackOp } from '@core/ops/duplicateTrack'
import { projectStore } from '@/state/projectStore'
import { transport } from '@/state/transport'
import { selection } from '@/state/selection'
import { commentUi } from '@/state/commentUi'
import { appShell } from '@/state/appShell'
import { paletteUi } from '@/state/paletteUi'
import { newProject, openProject, saveProject } from './projectFile'
import {
  copySelectedClip,
  cutSelectedClip,
  duplicateSelectedClip,
  pasteClip,
  splitSelectedClipAtPlayhead
} from './clipActions'

/** App-wide keyboard shortcuts. Inactive while a text field has focus. */
export function useGlobalShortcuts(): void {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      const target = e.target as HTMLElement
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
        return

      const mod = e.ctrlKey || e.metaKey

      if (mod && e.key.toLowerCase() === 'p' && appShell.view === 'project') {
        e.preventDefault() // overrides the browser's print dialog
        paletteUi.toggle()
        return
      }

      // On the home screen only the launcher shortcuts apply.
      if (appShell.view === 'home') {
        if (mod && e.key.toLowerCase() === 'o') {
          e.preventDefault()
          void openProject()
        } else if (mod && e.shiftKey && e.key.toLowerCase() === 'n') {
          e.preventDefault()
          newProject()
        }
        return
      }

      if (e.code === 'Space') {
        e.preventDefault()
        // Space stops-and-returns to where play began; Shift+Space goes
        // to the very beginning of the song.
        if (e.shiftKey) transport.returnToStart()
        else transport.toggleReturn()
        return
      }
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
      if (mod && e.shiftKey && e.key.toLowerCase() === 'n') {
        e.preventDefault()
        newProject()
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
      if (mod && e.key.toLowerCase() === 'c') {
        if (copySelectedClip()) e.preventDefault()
        return
      }
      if (mod && e.key.toLowerCase() === 'x') {
        e.preventDefault()
        cutSelectedClip()
        return
      }
      if (mod && e.key.toLowerCase() === 'v') {
        e.preventDefault()
        pasteClip()
        return
      }
      if (mod && e.key.toLowerCase() === 'd') {
        e.preventDefault()
        if (e.shiftKey) {
          // Ctrl+Shift+D duplicates the selected clip's track.
          const clip = selection.selectedClipId
            ? projectStore.state.clips[selection.selectedClipId]
            : undefined
          if (clip) {
            const op = buildDuplicateTrackOp(projectStore.state, clip.trackId)
            if (op) projectStore.dispatch(op)
          }
        } else {
          duplicateSelectedClip()
        }
        return
      }
      if (mod && e.key.toLowerCase() === 'e') {
        e.preventDefault()
        splitSelectedClipAtPlayhead()
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
