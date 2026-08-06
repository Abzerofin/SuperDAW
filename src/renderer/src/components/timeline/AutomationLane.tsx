import { useState } from 'react'
import type { AutomationParam, AutomationPoint, Track } from '@core/model/types'
import { automationOf } from '@core/model/types'
import { newId } from '@core/model/ids'
import { projectStore } from '@/state/projectStore'
import { useProjectState } from '@/state/hooks'
import { automationUi, useAutomationUi } from '@/state/automationUi'
import { capturePointer } from '@/lib/pointer'
import { AUTO_H } from './geometry'

const PAD = 5 // px inset so points at value 0/1 stay grabbable

const PARAMS: AutomationParam[] = ['volume', 'pan']

/** Neutral value when a curve has no points: unity gain / centered pan. */
function restingValue(param: AutomationParam): number {
  return param === 'volume' ? 1 : 0.5
}

function pointLabel(param: AutomationParam, value: number): string {
  if (param === 'volume') return `${Math.round(value * 100)}%`
  const pan = value * 2 - 1
  if (Math.abs(pan) < 0.01) return 'C'
  return `${Math.round(Math.abs(pan) * 100)}${pan < 0 ? 'L' : 'R'}`
}

interface Props {
  track: Track
  pxPerTick: number
  contentW: number
}

/**
 * An automation lane under a track, editing one parameter at a time
 * (volume multiplies the fader; pan drives the stereo panner). Double-click
 * adds a point, drag moves it (one op on release), double-click a point
 * deletes it.
 */
export function AutomationLane({ track, pxPerTick, contentW }: Props): React.JSX.Element {
  const state = useProjectState()
  const param = useAutomationUi().paramOf(track.id)
  const [drag, setDrag] = useState<{
    pointId: string
    originX: number
    originY: number
    origTicks: number
    origValue: number
    ticks: number
    value: number
  } | null>(null)

  const points = automationOf(state, track.id, param).map((p) =>
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
      param,
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

  // Curve polyline: flat at the resting value when empty; held at edge
  // values outside points.
  const path =
    points.length === 0
      ? `0,${valueToY(restingValue(param))} ${contentW},${valueToY(restingValue(param))}`
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
      <span className="auto-lane-label">
        {PARAMS.map((p) => (
          <button
            key={p}
            className={`auto-param ${p === param ? 'auto-param-active' : ''}`}
            onDoubleClick={(e) => e.stopPropagation()}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => automationUi.setParam(track.id, p)}
          >
            {p}
          </button>
        ))}
      </span>
      <svg className="auto-svg" width={contentW} height={AUTO_H}>
        {param === 'pan' && (
          <line x1={0} y1={valueToY(0.5)} x2={contentW} y2={valueToY(0.5)} className="auto-center" />
        )}
        <polyline points={path} className="auto-curve" />
      </svg>
      {points.map((point) => (
        <div
          key={point.id}
          className="auto-point"
          style={{ left: point.ticks * pxPerTick - 5, top: valueToY(point.value) - 5 }}
          title={`${pointLabel(param, point.value)} — double-click to delete`}
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
