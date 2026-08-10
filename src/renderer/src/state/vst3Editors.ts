import { projectStore } from './projectStore'
import { vst3Dock } from './vst3Dock'

/**
 * Plugin editors (main process hosts the GUIs; see src/main/vst3). Every
 * VST3 insert docks its editor automatically — this module turns the
 * editor's events into ordinary document ops, so GUI edits are undoable,
 * synced, and drive processing exactly like slider edits:
 *
 * - Knob gestures arrive as begin/edit/end. One gesture = ONE op: values
 *   accumulate during the drag and dispatch on 'end' — a GUI knob streams
 *   dozens of performEdits per second, and each op would restart the
 *   live-preview pipeline.
 * - 'state' arrives when an editor closes (its card unmounts: track
 *   switch, tab close, plugin removed), carrying the plugin's final
 *   component chunk. For GUI-only plugins (zero parameters) this is the
 *   ONLY place their edits exist.
 */

/** In-flight gesture values per instance, keyed by stringified param id. */
const gestures = new Map<string, Map<string, number>>()

let wired = false

export function wireEditorEvents(): void {
  if (wired) return
  const api = window.superdaw
  if (!api?.onVst3EditorEvent) return
  wired = true

  // The other direction: a COLLABORATOR's param edit must reach any editor
  // we have open (and the hosted instance behind it) — otherwise the GUI
  // shows stale values and closing it would capture pre-edit state over
  // the peer's change. Main no-ops when no editor is open; non-numeric
  // param keys (builtins) are skipped.
  if (api.vst3SetEditorParam) {
    const push = (instanceId: string, param: string, value: number): void => {
      const paramId = Number(param)
      if (!Number.isFinite(paramId)) return
      void api.vst3SetEditorParam({ instanceId, paramId, value })
    }
    projectStore.onOperation((envelope, source) => {
      if (source !== 'remote') return
      const op = envelope.op
      if (op.type === 'plugin/setParam') push(op.instanceId, op.param, op.value)
      else if (op.type === 'plugin/setParams') {
        for (const [param, value] of Object.entries(op.params)) push(op.instanceId, param, value)
      }
    })
  }

  api.onVst3EditorEvent((event) => {
    if (event.kind === 'state') {
      if (typeof event.stateBlob === 'string') {
        projectStore.dispatch({
          type: 'plugin/setState',
          instanceId: event.instanceId,
          stateBlob: event.stateBlob
        })
      }
      return
    }

    if (event.paramId === undefined) return

    // A docked plugin resized its own editor: grow/shrink its placeholder.
    if (event.kind === 'resize') {
      vst3Dock.setDims(event.instanceId, {
        width: Math.round(event.paramId),
        height: Math.round(event.value ?? 0)
      })
      return
    }

    const param = String(event.paramId)

    if (event.kind === 'begin') {
      let held = gestures.get(event.instanceId)
      if (!held) gestures.set(event.instanceId, (held = new Map()))
      held.set(param, Number.NaN) // gesture open, no value yet
      return
    }

    if (event.kind === 'edit') {
      const held = gestures.get(event.instanceId)
      if (held?.has(param)) {
        held.set(param, event.value ?? 0)
      } else {
        // An edit outside a begin/end pair (buttons, menus): dispatch as
        // its own gesture.
        projectStore.dispatch({
          type: 'plugin/setParam',
          instanceId: event.instanceId,
          param,
          value: event.value ?? 0
        })
      }
      return
    }

    if (event.kind === 'end') {
      const held = gestures.get(event.instanceId)
      const value = held?.get(param)
      held?.delete(param)
      if (value !== undefined && !Number.isNaN(value)) {
        projectStore.dispatch({
          type: 'plugin/setParam',
          instanceId: event.instanceId,
          param,
          value
        })
      }
    }
  })
}

