import { DEFAULT_MARKER_COLOR, nextMarkerName } from '@core/model/types'
import { newId } from '@core/model/ids'
import { projectStore } from '@/state/projectStore'
import { transport } from '@/state/transport'

/**
 * Arrangement-marker gestures. Markers are document state (undoable, in the
 * activity feed, synced), so everything here is one dispatch through the
 * ordinary op pipeline — Shift+click on the ruler and the rebindable
 * "add marker at playhead" shortcut both land in the same definition.
 */

/** Create an auto-named marker at an absolute tick position. */
export function addMarkerAtTicks(ticks: number): void {
  projectStore.dispatch({
    type: 'marker/create',
    marker: {
      id: newId('marker'),
      name: nextMarkerName(projectStore.state),
      ticks: Math.max(0, Math.round(ticks)),
      color: DEFAULT_MARKER_COLOR
    }
  })
}

/** The keymap action: a marker where the user sees the playhead. */
export function addMarkerAtPlayhead(): void {
  addMarkerAtTicks(transport.displayTicks())
}
