import { useState } from 'react'
import type { ParamDef } from '@core/model/effects'
import { capturePointer } from '@/lib/pointer'

const SLIDER_W = 116

/**
 * The generic plugin parameter control: a horizontal drag bar. Previews
 * per pointermove (through the engine, no ops) and commits ONE op on
 * release via onCommit. Double-click resets to the param's default.
 */
export function ParamSlider({
  def,
  value,
  onPreview,
  onCommit
}: {
  def: ParamDef
  value: number
  onPreview?: (value: number) => void
  onCommit: (value: number) => void
}): React.JSX.Element {
  const [dragValue, setDragValue] = useState<number | null>(null)
  const shown = dragValue ?? value
  const fraction = (shown - def.min) / (def.max - def.min)

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
          const v = valueAt(e)
          setDragValue(v)
          onPreview?.(v)
        }}
        onPointerMove={(e) => {
          if (dragValue === null) return
          const v = valueAt(e)
          setDragValue(v)
          onPreview?.(v)
        }}
        onPointerUp={() => {
          if (dragValue === null) return
          if (dragValue !== value) onCommit(dragValue)
          setDragValue(null)
        }}
        onDoubleClick={() => onCommit(def.default)}
        title="Drag to adjust · double-click to reset"
      >
        <div className="fx-slider-fill" style={{ width: `${fraction * 100}%` }} />
      </div>
      <span className="fx-param-value mono">
        {shown.toFixed(def.digits)}
        {def.unit}
      </span>
    </div>
  )
}
