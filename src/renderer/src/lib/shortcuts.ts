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
import { keymap } from '@/state/keymap'
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

/** Duplicate the selected track — or the selected clip's track. */
function duplicateSelectedTrack(): void {
  const trackId =
    selection.selectedTrackId ??
    (selection.selectedClipId
      ? projectStore.state.clips[selection.selectedClipId]?.trackId
      : undefined)
  if (trackId) {
    const op = buildDuplicateTrackOp(projectStore.state, trackId)
    if (op) projectStore.dispatch(op)
  }
}

/**
 * App-wide keyboard shortcuts. Inactive while a text field has focus.
 * WHAT combo triggers WHICH action lives in the keymap (state/keymap.ts,
 * rebindable in Settings ▸ Keyboard Shortcuts); this handler only says what
 * each action DOES and in which context it applies. The 2–9 slice keys are
 * the one fixed family (a parameterized binding doesn't fit single combos).
 */
export function useGlobalShortcuts(): void {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      const target = e.target as HTMLElement
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
        return

      const id = keymap.resolve(e)

      // On the home screen only the launcher shortcuts apply.
      if (appShell.view === 'home') {
        if (id === 'project.open') {
          e.preventDefault()
          void openProject()
        } else if (id === 'project.new') {
          e.preventDefault()
          newProject()
        }
        return
      }

      switch (id) {
        case 'palette.toggle':
          e.preventDefault() // overrides the browser's print dialog
          paletteUi.toggle()
          return
        case 'transport.playPause':
          // Stops-and-returns to where play began.
          e.preventDefault()
          transport.toggleReturn()
          return
        case 'transport.returnToStart':
          e.preventDefault()
          transport.returnToStart()
          return
        case 'project.save':
          e.preventDefault()
          void saveProject(false)
          return
        case 'project.saveAs':
          e.preventDefault()
          void saveProject(true)
          return
        case 'project.open':
          e.preventDefault()
          void openProject()
          return
        case 'project.new':
          e.preventDefault()
          newProject()
          return
        case 'edit.undo':
          e.preventDefault()
          projectStore.undo()
          return
        case 'edit.redo':
          e.preventDefault()
          projectStore.redo()
          return
        case 'clip.copy':
          if (copySelectedClip()) e.preventDefault()
          return
        case 'clip.cut':
          e.preventDefault()
          cutSelectedClip()
          return
        case 'clip.paste':
          e.preventDefault()
          pasteClip()
          return
        case 'clip.duplicate':
          e.preventDefault()
          duplicateSelectedClip()
          return
        case 'track.duplicate':
          e.preventDefault()
          duplicateSelectedTrack()
          return
        case 'clip.split':
          splitSelectedClipAtEditPoint()
          return
        case 'selection.all':
          // Widens a clip selection to every clip; with nothing selected
          // it deliberately selects nothing.
          if (selection.selectedClipIds.size > 0) {
            e.preventDefault()
            selection.selectClips(
              Object.keys(projectStore.state.clips),
              selection.selectedClipId ?? undefined
            )
          }
          return
        case 'track.mute': {
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
        case 'track.monitor': {
          const trackId = selection.selectedTrackId
          if (trackId && projectStore.state.tracks[trackId]?.kind === 'audio') {
            void trackInputs.toggleMonitor(trackId)
          }
          return
        }
        case 'track.loop': {
          const trackId = selection.selectedTrackId
          if (trackId) audioEngine.setTrackLoop(trackId, !audioEngine.isTrackLooping(trackId))
          return
        }
        case 'notes.quantize':
          quantizeNotes(selectedClipNoteIds(), quantizeGridTicks())
          return
        case 'notes.humanize':
          humanizeNotes(selectedClipNoteIds())
          return
        case 'clip.comment': {
          const clipId = selection.selectedClipId
          if (clipId) {
            e.preventDefault()
            commentUi.open({ kind: 'clip', id: clipId })
          }
          return
        }
        case 'selection.delete': {
          const clipIds = [...selection.selectedClipIds]
          if (clipIds.length > 0) {
            selection.select(null)
            projectStore.dispatch(
              clipIds.length === 1
                ? { type: 'clip/delete', clipId: clipIds[0] }
                : { type: 'clip/deleteMany', clipIds }
            )
          }
          return
        }
      }

      // 2..9 slice the selected clips into that many equal pieces. Bare
      // digits only: Ctrl/Alt combinations belong to the browser and to
      // future tool switching.
      const mod = e.ctrlKey || e.metaKey
      if (!mod && !e.altKey && /^[2-9]$/.test(e.key) && selection.selectedClipIds.size > 0) {
        e.preventDefault()
        sliceSelectionIntoEqualParts(Number(e.key))
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])
}
