import { useRef, useState } from 'react'
import { capturePointer } from '@/lib/pointer'

/**
 * A standard continuous rotary knob: 270° sweep, vertical drag (hold Shift
 * for fine control), double-click resets to `defaultValue`. Follows the
 * one-gesture-one-op rule: `onPreview` fires on every move for live audio
 * feedback, `onCommit` fires once on release.
 */

const SWEEP_DEG = 270
const START_DEG = -225 // sweep runs -225° .. +45° (0° = 3 o'clock, CCW-positive math below)
const DRAG_RANGE_PX = 140 // full sweep over this many pixels of vertical drag
const R = 13 // arc radius within the 36x36 viewbox

interface Props {
  value: number
  min: number
  max: number
  defaultValue: number
  /** Short readout under the knob, e.g. "35L" or "C". */
  format: (value: number) => string
  title: string
  /** Rendered width/height in px (default 36). The dial scales with it. */
  size?: number
  onPreview: (value: number) => void
  onCommit: (value: number) => void
}

function polar(deg: number): { x: number; y: number } {
  const rad = (deg * Math.PI) / 180
  return { x: 18 + R * Math.cos(rad), y: 18 + R * Math.sin(rad) }
}

/** SVG arc between two sweep angles (degrees along the knob's travel). */
function arcPath(fromDeg: number, toDeg: number): string {
  const a = polar(fromDeg)
  const b = polar(toDeg)
  const large = Math.abs(toDeg - fromDeg) > 180 ? 1 : 0
  const sweep = toDeg > fromDeg ? 1 : 0
  return `M ${a.x} ${a.y} A ${R} ${R} 0 ${large} ${sweep} ${b.x} ${b.y}`
}

export function Knob({
  value,
  min,
  max,
  defaultValue,
  format,
  title,
  size = 36,
  onPreview,
  onCommit
}: Props): React.JSX.Element {
  const [dragValue, setDragValue] = useState<number | null>(null)
  const origin = useRef({ y: 0, value: 0 })
  const shown = dragValue ?? value

  const begin = (e: React.PointerEvent): void => {
    if (e.button !== 0) return
    e.stopPropagation()
    capturePointer(e)
    origin.current = { y: e.clientY, value }
    setDragValue(value)
  }
  const move = (e: React.PointerEvent): void => {
    if (dragValue === null) return
    const fine = e.shiftKey ? 0.15 : 1
    const delta = ((origin.current.y - e.clientY) / DRAG_RANGE_PX) * (max - min) * fine
    const next = Math.min(max, Math.max(min, origin.current.value + delta))
    setDragValue(next)
    onPreview(next)
  }
  const end = (): void => {
    if (dragValue === null) return
    if (dragValue !== value) onCommit(dragValue)
    setDragValue(null)
  }

  const norm = (shown - min) / (max - min)
  const normDefault = (defaultValue - min) / (max - min)
  const angle = START_DEG + norm * SWEEP_DEG
  const defaultAngle = START_DEG + normDefault * SWEEP_DEG
  const tip = polar(angle)

  return (
    <div className="knob-wrap" title={title}>
      <svg
        className="knob"
        width={size}
        height={size}
        viewBox="0 0 36 36"
        onPointerDown={begin}
        onPointerMove={move}
        onPointerUp={end}
        onDoubleClick={() => onCommit(defaultValue)}
      >
        <path className="knob-track" d={arcPath(START_DEG, START_DEG + SWEEP_DEG)} />
        {/* Value arc fills from the neutral position toward the current one. */}
        {Math.abs(angle - defaultAngle) > 0.5 && (
          <path className="knob-fill" d={arcPath(defaultAngle, angle)} />
        )}
        <circle className="knob-body" cx={18} cy={18} r={9.5} />
        <line className="knob-pointer" x1={18} y1={18} x2={tip.x} y2={tip.y} />
      </svg>
      <div className="knob-value mono">{format(shown)}</div>
    </div>
  )
}
