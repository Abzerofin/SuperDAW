import { projectStore } from './projectStore'

/**
 * Plugin editor windows (main process hosts the GUIs; see src/main/vst3).
 * This module turns their events into ordinary document ops, so GUI edits
 * are undoable, synced, and drive processing exactly like slider edits:
 *
 * - Knob gestures arrive as begin/edit/end. One gesture = ONE op: values
 *   accumulate during the drag and dispatch on 'end' — a GUI knob streams
 *   dozens of performEdits per second, and each op would restart the
 *   live-preview pipeline.
 * - 'state' arrives when an editor window closes, carrying the plugin's
 *   final component chunk. For GUI-only plugins (zero parameters) this is
 *   the ONLY place their edits exist.
 */

/** In-flight gesture values per instance, keyed by stringified param id. */
const gestures = new Map<string, Map<string, number>>()

let wired = false

export function wireEditorEvents(): void {
  if (wired) return
  const api = window.superdaw
  if (!api?.onVst3EditorEvent) return
  wired = true

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

export function openPluginEditor(args: {
  instanceId: string
  uid: string
  stateBlob: string | null
  title: string
}): void {
  wireEditorEvents()
  void window.superdaw?.vst3OpenEditor?.(args)
}
