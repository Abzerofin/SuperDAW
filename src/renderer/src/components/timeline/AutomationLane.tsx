import { useState } from 'react'
import type { AutomationPoint, Track } from '@core/model/types'
import { automationOf } from '@core/model/types'
import { newId } from '@core/model/ids'
import { projectStore } from '@/state/projectStore'
import { useProjectState } from '@/state/hooks'
import { capturePointer } from '@/lib/pointer'
import { AUTO_H } from './geometry'

const PAD = 5 // px inset so points at value 0/1 stay grabbable

interface Props {
  track: Track
  pxPerTick: number
  contentW: number
}

/**
 * A volume-automation lane under a track. Double-click adds a point, drag
 * moves it (one op on release), double-click a point deletes it. The curve
 * multiplies the fader (1 = fader level, 0 = silence).
 */
export function AutomationLane({ track, pxPerTick, contentW }: Props): React.JSX.Element {
  const state = useProjectState()
  const [drag, setDrag] = useState<{
    pointId: string
    originX: number
    originY: number
    origTicks: number
    origValue: number
    ticks: number
    value: number
  } | null>(null)

  const points = automationOf(state, track.id, 'volume').map((p) =>
    drag && p.id === drag.pointId ? { ...p, ticks: drag.ticks, value: drag.value } : p
  )
  points.sort((a, b) => a.ticks - b.ticks)

  const valueToY = (value: number): number => PAD + (1 - value) * (AUTO_H - PAD * 2)
  const yToValue = (y: number): number =>
    Math.min(1, Math.max(0, 1 - (y - PAD) / (AUTO_H - PAD * 2)))

  const addPoint = (e: React.MouseEvent): void => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    const point: AutomationPoint = {
      id: newId('aut'),
      trackId: track.id,
      param: 'volume',
      ticks: Math.max(0, (e.clientX - rect.left) / pxPerTick),
      value: yToValue(e.clientY - rect.top)
    }
    projectStore.dispatch({ type: 'automation/add', point })
  }

  const beginDrag = (e: React.PointerEvent, point: AutomationPoint): void => {
    if (e.button !== 0) return
    e.stopPropagation()
    capturePointer(e)
    setDrag({
      pointId: point.id,
      originX: e.clientX,
      originY: e.clientY,
      origTicks: point.ticks,
      origValue: point.value,
      ticks: point.ticks,
      value: point.value
    })
  }

  const onPointerMove = (e: React.PointerEvent): void => {
    if (!drag) return
    setDrag({
      ...drag,
      ticks: Math.max(0, drag.origTicks + (e.clientX - drag.originX) / pxPerTick),
      value: Math.min(
        1,
        Math.max(0, drag.origValue - (e.clientY - drag.originY) / (AUTO_H - PAD * 2))
      )
    })
  }

  const endDrag = (): void => {
    if (!drag) return
    if (drag.ticks !== drag.origTicks || drag.value !== drag.origValue) {
      projectStore.dispatch({
        type: 'automation/move',
        pointId: drag.pointId,
        ticks: drag.ticks,
        value: drag.value
      })
    }
    setDrag(null)
  }

  // Curve polyline: flat at 1 when empty; held at edge values outside points.
  const path =
    points.length === 0
      ? `0,${valueToY(1)} ${contentW},${valueToY(1)}`
      : [
          `0,${valueToY(points[0].value)}`,
          ...points.map((p) => `${p.ticks * pxPerTick},${valueToY(p.value)}`),
          `${contentW},${valueToY(points[points.length - 1].value)}`
        ].join(' ')

  return (
    <div
      className="auto-lane"
      style={{ '--track-color': track.color } as React.CSSProperties}
      onDoubleClick={addPoint}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
    >
      <span className="auto-lane-label">volume</span>
      <svg className="auto-svg" width={contentW} height={AUTO_H}>
        <polyline points={path} className="auto-curve" />
      </svg>
      {points.map((point) => (
        <div
          key={point.id}
          className="auto-point"
          style={{ left: point.ticks * pxPerTick - 5, top: valueToY(point.value) - 5 }}
          title={`${Math.round(point.value * 100)}% — double-click to delete`}
          onPointerDown={(e) => beginDrag(e, point)}
          onDoubleClick={(e) => {
            e.stopPropagation()
            projectStore.dispatch({ type: 'automation/delete', pointId: point.id })
          }}
        />
      ))}
    </div>
  )
}
