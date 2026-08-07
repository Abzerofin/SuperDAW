import { saveProject } from './projectFile'
import { sessionFile } from '@/state/sessionFile'

/**
 * Unsaved-changes protection on window close.
 *
 * Electron: the main process intercepts `close` while dirty and shows
 * Save / Discard / Cancel; on "Save" it asks us to run the save flow and
 * reports back whether it completed (see main/index.ts).
 *
 * Browser dev mode: the standard beforeunload prompt.
 */
window.superdaw?.onSaveRequest(async () => {
  await saveProject()
  // Still dirty = the user cancelled the dialog, or the save failed
  // (saveProject reports that itself) — either way, do not close.
  return !sessionFile.dirty
})

if (!window.superdaw) {
  window.addEventListener('beforeunload', (e) => {
    if (!sessionFile.dirty) return
    e.preventDefault()
    e.returnValue = ''
  })
}
