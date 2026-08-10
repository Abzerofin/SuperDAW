import { useEffect } from 'react'
import { buildDuplicateTrackOp } from '@core/ops/duplicateTrack'
import { projectStore } from '@/state/projectStore'
import { transport } from '@/state/transport'
import { selection } from '@/state/selection'
import { commentUi } from '@/state/commentUi'
import { appShell } from '@/state/appShell'
import { paletteUi } from '@/state/paletteUi'
import { gridTicksFor, gridUi } from '@/state/gridUi'
import { trackInputs } from '@/state/trackInputs'
import { audioEngine } from '@/state/audioInstance'
import { newProject, openProject, saveProject } from './projectFile'
import {
  copySelectedClip,
  cutSelectedClip,
  duplicateSelectedClip,
  pasteClip,
  sliceSelectionIntoEqualParts,
  splitSelectedClipAtEditPoint
} from './clipActions'
import { DEFAULT_QUANTIZE_TICKS, humanizeNotes, quantizeNotes } from './noteActions'

/** Notes living on the selected clips (for timeline-level quantize/humanize). */
function selectedClipNoteIds(): string[] {
  const ids: string[] = []
  for (const note of Object.values(projectStore.state.notes)) {
    if (selection.selectedClipIds.has(note.clipId)) ids.push(note.id)
  }
  return ids
}

/** The snap grid as a quantize resolution; auto/off fall back to a 16th. */
function quantizeGridTicks(): number {
  const choice = gridUi.choice
  if (choice === 'auto' || choice === 'off') return DEFAULT_QUANTIZE_TICKS
  return gridTicksFor(choice, projectStore.state.timeSignature, 48)
}

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
        splitSelectedClipAtEditPoint()
        return
      }

      // Bare-letter workflow keys. The piano roll handles Q/H/Shift+A for
      // notes itself and stops propagation, so these act on the timeline.
      if (!mod && !e.altKey) {
        const key = e.key.toLowerCase()
        // Shift+A widens a clip selection to every clip; with nothing
        // selected it deliberately selects nothing.
        if (key === 'a' && e.shiftKey) {
          if (selection.selectedClipIds.size > 0) {
            e.preventDefault()
            selection.selectClips(
              Object.keys(projectStore.state.clips),
              selection.selectedClipId ?? undefined
            )
          }
          return
        }
        if (key === 's' && !e.shiftKey) {
          splitSelectedClipAtEditPoint()
          return
        }
        if (key === 'm' && !e.shiftKey) {
          const trackId = selection.selectedTrackId
          const track = trackId ? projectStore.state.tracks[trackId] : undefined
          if (track) {
            projectStore.dispatch({
              type: 'track/setMute',
              trackId: track.id,
              muted: !track.muted
            })
          }
          return
        }
        if (key === 'i' && !e.shiftKey) {
          const trackId = selection.selectedTrackId
          if (trackId && projectStore.state.tracks[trackId]?.kind === 'audio') {
            void trackInputs.toggleMonitor(trackId)
          }
          return
        }
        if (key === 'l' && !e.shiftKey) {
          const trackId = selection.selectedTrackId
          if (trackId) audioEngine.setTrackLoop(trackId, !audioEngine.isTrackLooping(trackId))
          return
        }
        if (key === 'd') {
          if (e.shiftKey) {
            // Shift+D duplicates the selected track (or the selected clip's).
            const trackId =
              selection.selectedTrackId ??
              (selection.selectedClipId
                ? projectStore.state.clips[selection.selectedClipId]?.trackId
                : undefined)
            if (trackId) {
              const op = buildDuplicateTrackOp(projectStore.state, trackId)
              if (op) projectStore.dispatch(op)
            }
          } else {
            duplicateSelectedClip()
          }
          return
        }
        if (key === 'q' && !e.shiftKey) {
          quantizeNotes(selectedClipNoteIds(), quantizeGridTicks())
          return
        }
        if (key === 'h' && !e.shiftKey) {
          humanizeNotes(selectedClipNoteIds())
          return
        }
      }

      // 2..9 slice the selected clips into that many equal pieces. Bare
      // digits only: Ctrl/Alt combinations belong to the browser and to
      // future tool switching.
      if (!mod && !e.altKey && /^[2-9]$/.test(e.key) && selection.selectedClipIds.size > 0) {
        e.preventDefault()
        sliceSelectionIntoEqualParts(Number(e.key))
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
        const clipIds = [...selection.selectedClipIds]
        if (clipIds.length > 0) {
          selection.select(null)
          projectStore.dispatch(
            clipIds.length === 1
              ? { type: 'clip/delete', clipId: clipIds[0] }
              : { type: 'clip/deleteMany', clipIds }
          )
        }
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])
}
