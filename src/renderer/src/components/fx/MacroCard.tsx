import { useState } from 'react'
import { createPortal } from 'react-dom'
import type { Track } from '@core/model/types'
import { MAX_MACROS, defaultMacro, type TrackMacro } from '@core/model/macros'
import { buildMacroSetValue, macroParamValues } from '@core/ops/macros'
import { projectStore } from '@/state/projectStore'
import { audioEngine } from '@/state/audioInstance'
import { parsePercent } from '@/lib/valueParse'
import { contextMenuStyle } from '@/lib/contextMenu'
import { useDismiss } from '@/lib/dismiss'
import { Knob } from '../mixer/Knob'

/**
 * The compact "Macros" card at the start of the effects rack: four knobs
 * per track, each mappable to any number of insert parameters (map via
 * right-click on a param slider; see PluginSection). Dragging previews
 * every mapped param live through the engine and dispatches ONE
 * `macro/setValue` on release; double-click resets to 0. Right-click a
 * knob to rename it inline or clear its mappings.
 */
export function MacroCard({ track }: { track: Track }): React.JSX.Element {
  const [menu, setMenu] = useState<{ index: number; x: number; y: number } | null>(null)
  const [renaming, setRenaming] = useState<number | null>(null)

  const macroAt = (index: number): TrackMacro => track.macros?.[index] ?? defaultMacro(index)

  const preview = (index: number, value: number): void => {
    // Group the derived values per instance so each plugin gets one
    // engine push per move (the ParamSlider pattern, fanned out).
    const byInstance = new Map<string, Record<string, number>>()
    for (const entry of macroParamValues(projectStore.state, track.id, index, value)) {
      let params = byInstance.get(entry.instanceId)
      if (!params) byInstance.set(entry.instanceId, (params = {}))
      params[entry.param] = entry.value
    }
    for (const [instanceId, params] of byInstance) {
      audioEngine.previewPluginParams(instanceId, params)
    }
  }

  const commit = (index: number, value: number): void => {
    const op = buildMacroSetValue(projectStore.state, track.id, index, value)
    if (op) projectStore.dispatch(op)
  }

  const rename = (index: number, name: string): void => {
    setRenaming(null)
    const trimmed = name.trim()
    if (trimmed === '' || trimmed === macroAt(index).name) return
    projectStore.dispatch({ type: 'macro/configure', trackId: track.id, index, name: trimmed })
  }

  return (
    <div className="fx-card fx-macros-card">
      <div className="fx-section">
        <div className="fx-section-head">
          <span className="fx-section-title">Macros</span>
        </div>
        <div className="fx-macros">
          {Array.from({ length: MAX_MACROS }, (_, index) => {
            const macro = macroAt(index)
            const live = macroParamValues(projectStore.state, track.id, index, macro.value)
            return (
              <div
                key={index}
                className="fx-macro"
                onContextMenu={(e) => {
                  e.preventDefault()
                  e.stopPropagation()
                  setMenu({ index, x: e.clientX, y: e.clientY })
                }}
              >
                <Knob
                  value={macro.value}
                  min={0}
                  max={1}
                  defaultValue={0}
                  format={(v) => `${Math.round(v * 100)}%`}
                  parse={parsePercent}
                  title={
                    macro.targets.length === 0
                      ? `${macro.name} — unmapped. Right-click a plugin parameter to map it here.`
                      : `${macro.name} — sweeps ${live.length} parameter${live.length === 1 ? '' : 's'} · double-click to reset · right-click to rename`
                  }
                  onPreview={(v) => preview(index, v)}
                  onCommit={(v) => commit(index, v)}
                />
                {renaming === index ? (
                  <input
                    className="fx-macro-name-input"
                    defaultValue={macro.name}
                    autoFocus
                    onFocus={(e) => e.currentTarget.select()}
                    onBlur={(e) => rename(index, e.currentTarget.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') e.currentTarget.blur()
                      if (e.key === 'Escape') setRenaming(null)
                    }}
                    onPointerDown={(e) => e.stopPropagation()}
                  />
                ) : (
                  <span
                    className={`fx-macro-name ${macro.targets.length > 0 ? 'fx-macro-name-mapped' : ''}`}
                    onDoubleClick={() => setRenaming(index)}
                    title="Double-click to rename"
                  >
                    {macro.name}
                  </span>
                )}
              </div>
            )
          })}
        </div>
      </div>
      {menu && (
        <MacroMenu
          x={menu.x}
          y={menu.y}
          macro={macroAt(menu.index)}
          onRename={() => {
            setMenu(null)
            setRenaming(menu.index)
          }}
          onClear={() => {
            setMenu(null)
            projectStore.dispatch({
              type: 'macro/configure',
              trackId: track.id,
              index: menu.index,
              targets: []
            })
          }}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  )
}

function MacroMenu({
  x,
  y,
  macro,
  onRename,
  onClear,
  onClose
}: {
  x: number
  y: number
  macro: TrackMacro
  onRename: () => void
  onClear: () => void
  onClose: () => void
}): React.JSX.Element {
  useDismiss(true, onClose)
  return createPortal(
    <div
      className="menu-panel"
      style={contextMenuStyle(x, y, 180, 88)}
      onPointerDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
    >
      <button className="menu-item" onClick={onRename}>
        <span>Rename</span>
      </button>
      <button className="menu-item" disabled={macro.targets.length === 0} onClick={onClear}>
        <span>Clear targets ({macro.targets.length})</span>
      </button>
    </div>,
    document.body
  )
}
