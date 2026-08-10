import { memo, useState, useSyncExternalStore } from 'react'
import type { AutomationPoint, Track } from '@core/model/types'
import { automationOf, pluginsOfTrack } from '@core/model/types'
import { denormalizeParam, normalizeParam, type ParamDef } from '@core/model/effects'
import { paramDefsOf } from '@core/plugins/builtin'
import { newId } from '@core/model/ids'
import { projectStore } from '@/state/projectStore'
import { arrayShallowEqual, useProjectSelector } from '@/state/hooks'
import { automationUi, type AutomationTarget } from '@/state/automationUi'
import { capturePointer } from '@/lib/pointer'
import { AUTO_H } from './geometry'

const PAD = 5 // px inset so points at value 0/1 stay grabbable

/** Stable fallback target when a lane's chosen insert has been removed. */
const DEAD_TARGET: AutomationTarget = { param: 'volume' }

interface Props {
  track: Track
  pxPerTick: number
  contentW: number
}

/**
 * An automation lane under a track, editing one parameter at a time —
 * volume (multiplies the fader), pan (drives the panner), or any insert
 * effect's parameter (owns that knob during playback). Double-click adds
 * a point, drag moves it (one op on release), double-click a point
 * deletes it.
 */
export const AutomationLane = memo(function AutomationLane({
  track,
  pxPerTick,
  contentW
}: Props): React.JSX.Element {
  const stored = useSyncExternalStore(automationUi.subscribe, () =>
    automationUi.targetOf(track.id)
  )
  const storedInstance = useProjectSelector((s) =>
    stored.instanceId !== undefined ? s.plugins[stored.instanceId] : undefined
  )
  // The chosen insert may have been removed (its points cascade away with
  // it) — fall back to the track's own volume rather than a dead lane.
  const target: AutomationTarget =
    stored.instanceId !== undefined && !storedInstance ? DEAD_TARGET : stored
  const targetInstance = target.instanceId !== undefined ? storedInstance : undefined
  const targetDef: ParamDef | undefined =
    targetInstance !== undefined ? paramDefsOf(targetInstance.descriptor)?.[target.param] : undefined
  const [drag, setDrag] = useState<{
    pointId: string
    originX: number
    originY: number
    origTicks: number
    origValue: number
    ticks: number
    value: number
  } | null>(null)

  // Recomputed only when a plugin op lands; identity held via shallow
  // equality so unrelated ops leave this lane's render untouched.
  const inserts = useProjectSelector((s) => pluginsOfTrack(s, track.id), arrayShallowEqual)

  /** Neutral value when a curve has no points. */
  const restingValue = (): number => {
    if (targetDef) return normalizeParam(targetDef, targetDef.default)
    return target.param === 'volume' ? 1 : 0.5
  }

  const pointLabel = (value: number): string => {
    if (targetDef) return `${denormalizeParam(targetDef, value).toFixed(targetDef.digits)}${targetDef.unit}`
    if (target.param === 'volume') return `${Math.round(value * 100)}%`
    const pan = value * 2 - 1
    if (Math.abs(pan) < 0.01) return 'C'
    return `${Math.round(Math.abs(pan) * 100)}${pan < 0 ? 'L' : 'R'}`
  }

  const storedPoints = useProjectSelector(
    (s) => automationOf(s, track.id, target.param, target.instanceId),
    arrayShallowEqual
  )
  const points = storedPoints.map((p) =>
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
      param: target.param,
      ...(target.instanceId !== undefined ? { instanceId: target.instanceId } : {}),
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
      ? `0,${valueToY(restingValue())} ${contentW},${valueToY(restingValue())}`
      : [
          `0,${valueToY(points[0].value)}`,
          ...points.map((p) => `${p.ticks * pxPerTick},${valueToY(p.value)}`),
          `${contentW},${valueToY(points[points.length - 1].value)}`
        ].join(' ')

  const stop = (e: React.SyntheticEvent): void => e.stopPropagation()

  return (
    <div
      className="auto-lane"
      style={{ '--track-color': track.color } as React.CSSProperties}
      onDoubleClick={addPoint}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
    >
      <span className="auto-lane-label">
        {(['volume', 'pan'] as const).map((p) => (
          <button
            key={p}
            className={`auto-param ${
              target.instanceId === undefined && p === target.param ? 'auto-param-active' : ''
            }`}
            onDoubleClick={stop}
            onPointerDown={stop}
            onClick={() => automationUi.setTarget(track.id, { param: p })}
          >
            {p}
          </button>
        ))}
        {inserts.length > 0 && (
          <select
            className={`auto-param auto-param-select ${
              target.instanceId !== undefined ? 'auto-param-active' : ''
            }`}
            title="Automate an effect parameter"
            value={target.instanceId !== undefined ? `${target.instanceId}:${target.param}` : ''}
            onDoubleClick={stop}
            onPointerDown={stop}
            onChange={(e) => {
              const v = e.target.value
              if (!v) return
              const split = v.indexOf(':')
              automationUi.setTarget(track.id, {
                instanceId: v.slice(0, split),
                param: v.slice(split + 1)
              })
            }}
          >
            <option value="">
              {targetInstance !== undefined && targetDef
                ? `${targetInstance.descriptor.name} · ${targetDef.label}`
                : 'FX param…'}
            </option>
            {inserts.map((instance) => {
              const defs = paramDefsOf(instance.descriptor)
              if (!defs) return null
              return (
                <optgroup key={instance.id} label={instance.descriptor.name}>
                  {Object.entries(defs).map(([key, def]) => (
                    <option key={key} value={`${instance.id}:${key}`}>
                      {def.label}
                    </option>
                  ))}
                </optgroup>
              )
            })}
          </select>
        )}
      </span>
      <svg className="auto-svg" width={contentW} height={AUTO_H}>
        {target.instanceId === undefined && target.param === 'pan' && (
          <line x1={0} y1={valueToY(0.5)} x2={contentW} y2={valueToY(0.5)} className="auto-center" />
        )}
        <polyline points={path} className="auto-curve" />
      </svg>
      {points.map((point) => (
        <div
          key={point.id}
          className="auto-point"
          style={{ left: point.ticks * pxPerTick - 5, top: valueToY(point.value) - 5 }}
          title={`${pointLabel(point.value)} — double-click to delete`}
          onPointerDown={(e) => beginDrag(e, point)}
          onDoubleClick={(e) => {
            e.stopPropagation()
            projectStore.dispatch({ type: 'automation/delete', pointId: point.id })
          }}
        />
      ))}
    </div>
  )
})
