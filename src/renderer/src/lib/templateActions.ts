import {
  parseProjectTemplate,
  projectFromTemplate,
  PROJECT_TEMPLATE_EXTENSION,
  serializeProjectTemplate
} from '@core/persistence/projectTemplate'
import { projectStore } from '@/state/projectStore'
import { assetStore } from '@/state/audioInstance'
import { transport } from '@/state/transport'
import { selection } from '@/state/selection'
import { sessionFile } from '@/state/sessionFile'
import { pianoRollUi } from '@/state/pianoRollUi'
import { stepSeqUi } from '@/state/stepSeqUi'
import { trackInputs } from '@/state/trackInputs'
import { collab } from '@/state/collab'
import { gridUi } from '@/state/gridUi'
import { appShell } from '@/state/appShell'
import { autosave } from './autosave'

/**
 * Session templates (core/persistence/projectTemplate): save the open
 * project's SETUP — track tree, insert chains, routing, tempo/signature,
 * project settings, no content — and start new projects from it. Follows
 * the track-preset pattern: portable JSON through the generic file IPC,
 * browser download/picker fallback.
 */

export async function saveProjectTemplate(): Promise<void> {
  const state = projectStore.state
  const json = serializeProjectTemplate(state, state.name)
  const data = new TextEncoder().encode(json)
  const name = `${state.name.trim() || 'Template'}.${PROJECT_TEMPLATE_EXTENSION}`
  const bridge = window.superdaw
  if (bridge) {
    await bridge.exportFile({
      data,
      defaultName: name,
      filterName: 'SuperDAW Project Template',
      ext: PROJECT_TEMPLATE_EXTENSION
    })
    return
  }
  const url = URL.createObjectURL(new Blob([data.buffer as ArrayBuffer]))
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = name
  anchor.click()
  URL.revokeObjectURL(url)
}

/**
 * Pick a template file and start a new project from it. Same guards as
 * newProject: never under a live session, confirm before discarding
 * unsaved work. The result is a fresh unsaved project.
 */
export async function newProjectFromTemplate(): Promise<void> {
  if (collab.mode !== 'off') {
    window.alert(
      'Leave the collaboration session first — a new project cannot replace the document a running session is syncing.'
    )
    return
  }
  const bridge = window.superdaw
  if (bridge) {
    const result = await bridge.openFile({
      filterName: 'SuperDAW Project Template',
      ext: PROJECT_TEMPLATE_EXTENSION
    })
    if (result) startFromTemplateText(new TextDecoder().decode(result.data), result.name)
    return
  }
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = `.${PROJECT_TEMPLATE_EXTENSION}`
  input.onchange = async () => {
    const file = input.files?.[0]
    if (file) startFromTemplateText(await file.text(), file.name)
  }
  input.click()
}

function startFromTemplateText(text: string, fileName: string): void {
  let template
  try {
    template = parseProjectTemplate(text)
  } catch (error) {
    window.alert(error instanceof Error ? error.message : 'Could not read the template file')
    return
  }
  const wasDirty = sessionFile.dirty
  if (wasDirty && !window.confirm('Discard unsaved changes and start a new project?')) {
    return
  }
  const fallback = fileName.replace(/\.[^.]+$/, '') || template.name
  const state = projectFromTemplate(template, fallback, Date.now())

  transport.stop()
  transport.setPosition(0)
  selection.clear()
  pianoRollUi.close()
  stepSeqUi.close()
  void trackInputs.stopAllMonitors()
  assetStore.clear()
  projectStore.loadProject(state)
  gridUi.set(state.settings.defaultGrid)
  sessionFile.markLoaded(null)
  if (wasDirty) void autosave.clearRecovery()
  appShell.enterProject()
}
