import type { ArrangementMarker } from '@core/model/types'
import { projectStore } from '@/state/projectStore'
import { TRACK_COLORS } from '@/lib/colors'
import { contextMenuStyle } from '@/lib/contextMenu'

/**
 * Right-click menu for an arrangement marker: rename inline (one
 * `marker/update` on Enter/blur, Escape cancels), recolor from the same
 * palette clips use, delete. Every action is one op — undoable, in the
 * activity feed, synced. Which marker is being renamed is ephemeral by
 * construction: it's just this menu's input.
 */
export function MarkerMenu({
  marker,
  x,
  y,
  onClose
}: {
  marker: ArrangementMarker
  x: number
  y: number
  onClose: () => void
}): React.JSX.Element {
  return (
    <div
      className="clipmenu markermenu"
      style={contextMenuStyle(x, y, 208, 180)}
      onPointerDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
    >
      <input
        key={marker.id}
        className="clipmenu-title clipmenu-title-input"
        title="Marker name — click to rename"
        defaultValue={marker.name}
        spellCheck={false}
        autoFocus
        onFocus={(e) => e.currentTarget.select()}
        onKeyDown={(e) => {
          e.stopPropagation() // typing must not trigger app shortcuts
          if (e.key === 'Enter') e.currentTarget.blur()
          if (e.key === 'Escape') {
            e.currentTarget.value = marker.name
            e.currentTarget.blur()
          }
        }}
        onBlur={(e) => {
          const name = e.target.value.trim()
          if (name && name !== marker.name) {
            projectStore.dispatch({ type: 'marker/update', markerId: marker.id, name })
          }
        }}
      />

      <div className="menu-sep" />
      <div className="clipmenu-colors">
        {TRACK_COLORS.map((color) => (
          <button
            key={color}
            className={`color-swatch ${marker.color === color ? 'color-swatch-active' : ''}`}
            style={{ background: color }}
            title={color}
            onClick={() =>
              projectStore.dispatch({ type: 'marker/update', markerId: marker.id, color })
            }
          />
        ))}
      </div>

      <div className="menu-sep" />
      <button
        className="menu-item"
        onClick={() => {
          projectStore.dispatch({ type: 'marker/delete', markerId: marker.id })
          onClose()
        }}
      >
        <span>Delete marker</span>
      </button>
    </div>
  )
}
