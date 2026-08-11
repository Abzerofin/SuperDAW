import { useRef, useState } from 'react'
import type { ParamDef } from '@core/model/effects'
import { capturePointer } from '@/lib/pointer'
import { parseNumberIn, parsePercent } from '@/lib/valueParse'
import { EditableValue } from '../controls/EditableValue'

const SLIDER_W = 116
/** Shift slows the drag to this fraction — fine adjustment. */
const FINE = 0.15

/**
 * The generic plugin parameter control: a horizontal drag bar. Previews
 * per pointermove (through the engine, no ops) and commits ONE op on
 * release via onCommit. Double-click resets to the param's default;
 * Shift while dragging is fine adjustment; clicking the readout types an
 * exact value.
 */
export function ParamSlider({
  def,
  value,
  percent = false,
  onPreview,
  onCommit
}: {
  def: ParamDef
  value: number
  /**
   * The stored value is a plugin-owned normalized 0..1 (see
   * isNormalizedParam), so show it as a percentage. The VALUE is untouched
   * — only its presentation — because 0..1 is the plugin's contract.
   */
  percent?: boolean
  onPreview?: (value: number) => void
  onCommit: (value: number) => void
}): React.JSX.Element {
  const [dragValue, setDragValue] = useState<number | null>(null)
  const lastX = useRef(0)
  const shown = dragValue ?? value
  const fraction = (shown - def.min) / (def.max - def.min)

  const clamp = (v: number): number => Math.min(def.max, Math.max(def.min, v))

  const valueAt = (e: React.PointerEvent): number => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    const f = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width))
    return def.min + f * (def.max - def.min)
  }

  return (
    <div className="fx-param">
      <span className="fx-param-label">{def.label}</span>
      <div
        className="fx-slider"
        style={{ width: SLIDER_W }}
        onPointerDown={(e) => {
          if (e.button !== 0) return
          capturePointer(e)
          lastX.current = e.clientX
          // Shift means "adjust from where it is", so the grab must not jump.
          const v = e.shiftKey ? value : valueAt(e)
          setDragValue(v)
          onPreview?.(v)
        }}
        onPointerMove={(e) => {
          if (dragValue === null) return
          // Incremental, so Shift can engage/release mid-drag: each step
          // integrates the pointer delta at the current fineness.
          const dx = e.clientX - lastX.current
          lastX.current = e.clientX
          const scale = e.shiftKey ? FINE : 1
          const v = clamp(dragValue + (dx / SLIDER_W) * (def.max - def.min) * scale)
          setDragValue(v)
          onPreview?.(v)
        }}
        onPointerUp={() => {
          if (dragValue === null) return
          if (dragValue !== value) onCommit(dragValue)
          setDragValue(null)
        }}
        onDoubleClick={() => onCommit(def.default)}
        title="Drag to adjust (Shift = fine) · double-click to reset"
      >
        <div className="fx-slider-fill" style={{ width: `${fraction * 100}%` }} />
      </div>
      <EditableValue
        className="fx-param-value"
        text={percent ? `${(shown * 100).toFixed(0)}%` : `${shown.toFixed(def.digits)}${def.unit}`}
        parse={percent ? parsePercent : parseNumberIn(def.min, def.max)}
        onCommit={onCommit}
      />
    </div>
  )
}
