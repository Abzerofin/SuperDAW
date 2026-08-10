import { useEffect, useRef, useState } from 'react'
import type { Route, Track } from '@core/model/types'
import { pluginsOfTrack, routesOfTrack } from '@core/model/types'
import { graphDepths, hasLivePath, linearChainEdges, routeIsValid } from '@core/model/routing'
import { newId } from '@core/model/ids'
import { projectStore } from '@/state/projectStore'
import { useProjectState } from '@/state/hooks'
import { capturePointer } from '@/lib/pointer'
import { audioEngine } from '@/state/audioInstance'
import { AddPluginCard } from './AddPluginCard'
import { newPaintGate, shouldPaint } from './PluginVisuals'

/**
 * The node view of a track's effects: every insert is a node with an in
 * and an out port, wires are Route ops. Drag out-port → in-port to
 * connect (fan-out and merge are free — Web Audio sums at 'Mix Out'),
 * drag a node body to place it, click a wire and Delete (or right-click
 * it) to cut. Every gesture is ONE op, so undo and collaboration ride
 * the ordinary pipeline.
 */

const NODE_W = 118
const NODE_H = 46
const COL_X = 170
const ROW_Y = 64
const TERM_Y = 78

type NodeKey = 'in' | 'out' | string

interface WireDrag {
  from: NodeKey
  x: number
  y: number
}

interface NodeDrag {
  id: string
  /** Pointer offset within the node, so it doesn't jump on grab. */
  grabX: number
  grabY: number
  x: number
  y: number
  moved: boolean
}

export function RoutingGraph({ track }: { track: Track }): React.JSX.Element {
  const state = useProjectState()
  const canvasRef = useRef<HTMLDivElement>(null)
  const [wireDrag, setWireDragState] = useState<WireDrag | null>(null)
  const wireDragRef = useRef<WireDrag | null>(null)
  const setWireDrag = (value: WireDrag | null): void => {
    wireDragRef.current = value
    setWireDragState(value)
  }
  const [nodeDrag, setNodeDragState] = useState<NodeDrag | null>(null)
  const nodeDragRef = useRef<NodeDrag | null>(null)
  const setNodeDrag = (value: NodeDrag | null): void => {
    nodeDragRef.current = value
    setNodeDragState(value)
  }
  const [selectedWire, setSelectedWire] = useState<string | null>(null)
  /** View zoom (Ctrl+wheel). Layout math stays in content coordinates. */
  const [zoom, setZoom] = useState(1)

  const inserts = pluginsOfTrack(state, track.id)
  const routes = routesOfTrack(state, track.id)
  const graphMode = routes.length > 0

  // Ctrl+wheel zoom (native listener — React wheel events are passive).
  // Registered above the empty-state return per the rules of hooks.
  useEffect(() => {
    const el = canvasRef.current
    if (!el) return
    const onWheel = (e: WheelEvent): void => {
      if (!e.ctrlKey) return
      e.preventDefault()
      setZoom((prev) => Math.min(2, Math.max(0.4, prev * (e.deltaY < 0 ? 1.15 : 1 / 1.15))))
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [graphMode])

  // ---------- layout ----------

  const depths = graphDepths(state, track.id)
  const perDepthCount = new Map<number, number>()
  const positions = new Map<NodeKey, { x: number; y: number }>()
  let maxX = COL_X
  for (const instance of inserts) {
    let x = instance.graphX
    let y = instance.graphY
    if (x === undefined || y === undefined) {
      const depth = depths.get(instance.id) ?? 0
      const row = perDepthCount.get(depth) ?? 0
      perDepthCount.set(depth, row + 1)
      x = COL_X + depth * COL_X
      y = 18 + row * ROW_Y
    }
    positions.set(instance.id, { x, y })
    maxX = Math.max(maxX, x)
  }
  // Terminals: stored positions when the user has placed them, else the
  // automatic layout. The drag preview below overrides either.
  positions.set('in', { x: track.graphInX ?? 14, y: track.graphInY ?? TERM_Y })
  positions.set('out', {
    x: track.graphOutX ?? maxX + COL_X,
    y: track.graphOutY ?? TERM_Y
  })
  if (nodeDrag) positions.set(nodeDrag.id, { x: nodeDrag.x, y: nodeDrag.y })

  const maxY = Math.max(...[...positions.values()].map((p) => p.y))
  const contentW = (positions.get('out')?.x ?? 0) + NODE_W + 40
  const contentH = Math.max(190, maxY + NODE_H + 30)

  const portPos = (key: NodeKey, side: 'in' | 'out'): { x: number; y: number } => {
    const p = positions.get(key) ?? { x: 0, y: 0 }
    return { x: side === 'in' ? p.x : p.x + NODE_W, y: p.y + NODE_H / 2 }
  }

  const canvasPoint = (e: { clientX: number; clientY: number }): { x: number; y: number } => {
    const rect = canvasRef.current?.getBoundingClientRect()
    if (!rect) return { x: 0, y: 0 }
    const el = canvasRef.current!
    // Scroll offsets are in scaled pixels; divide the whole thing back
    // into content coordinates.
    return {
      x: (e.clientX - rect.left + el.scrollLeft) / zoom,
      y: (e.clientY - rect.top + el.scrollTop) / zoom
    }
  }

  // ---------- gestures ----------

  const beginWire = (e: React.PointerEvent, from: NodeKey): void => {
    if (e.button !== 0) return
    e.stopPropagation()
    capturePointer(e)
    const p = portPos(from, 'out')
    setWireDrag({ from, x: p.x, y: p.y })
  }

  const beginNodeDrag = (e: React.PointerEvent, key: NodeKey): void => {
    if (e.button !== 0) return
    if ((e.target as HTMLElement).closest('button, .rg-port')) return
    e.stopPropagation()
    capturePointer(e)
    const p = positions.get(key)!
    const at = canvasPoint(e)
    setNodeDrag({ id: key, grabX: at.x - p.x, grabY: at.y - p.y, x: p.x, y: p.y, moved: false })
  }

  const onPointerMove = (e: React.PointerEvent): void => {
    if (wireDragRef.current) {
      const at = canvasPoint(e)
      setWireDrag({ ...wireDragRef.current, x: at.x, y: at.y })
      return
    }
    const drag = nodeDragRef.current
    if (drag) {
      const at = canvasPoint(e)
      setNodeDrag({
        ...drag,
        x: Math.max(0, at.x - drag.grabX),
        y: Math.max(0, at.y - drag.grabY),
        moved: true
      })
    }
  }

  const onPointerUp = (e: React.PointerEvent): void => {
    const wire = wireDragRef.current
    if (wire) {
      setWireDrag(null)
      const under = document.elementFromPoint(e.clientX, e.clientY)
      const port = under?.closest('[data-graph-in]')
      const to = port?.getAttribute('data-graph-in') as NodeKey | null
      if (to) {
        const route: Route = { id: newId('rte'), trackId: track.id, from: wire.from, to }
        // The reducer would drop an invalid edge anyway; checking first
        // avoids dispatching known no-ops (cycles, duplicates).
        if (routeIsValid(state, route)) {
          projectStore.dispatch({ type: 'route/addMany', routes: [route] })
        }
      }
      return
    }
    const drag = nodeDragRef.current
    if (drag) {
      setNodeDrag(null)
      if (drag.moved) {
        projectStore.dispatch(
          drag.id === 'in' || drag.id === 'out'
            ? {
                type: 'track/setGraphTerminal',
                trackId: track.id,
                terminal: drag.id,
                x: Math.round(drag.x),
                y: Math.round(drag.y)
              }
            : {
                type: 'plugin/setGraphPos',
                instanceId: drag.id,
                x: Math.round(drag.x),
                y: Math.round(drag.y)
              }
        )
      }
    }
  }

  const deleteWire = (routeId: string): void => {
    projectStore.dispatch({ type: 'route/deleteMany', routeIds: [routeId] })
    setSelectedWire(null)
  }

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if ((e.key === 'Delete' || e.key === 'Backspace') && selectedWire) {
      e.stopPropagation()
      deleteWire(selectedWire)
    }
  }

  // ---------- mode switches ----------

  const enableGraph = (): void => {
    const edges = linearChainEdges(inserts).map((edge) => ({
      id: newId('rte'),
      trackId: track.id,
      ...edge
    }))
    projectStore.dispatch({ type: 'route/addMany', routes: edges })
  }

  const backToChain = (): void => {
    projectStore.dispatch({ type: 'route/deleteMany', routeIds: routes.map((r) => r.id) })
  }

  if (!graphMode) {
    return (
      <div className="rg-empty">
        <p>
          Node routing lets one effect feed several others in parallel — branches merge back at
          the Mix Out node. The current rack order becomes the starting graph.
        </p>
        <button className="bay-btn" onClick={enableGraph}>
          Enable graph routing
        </button>
      </div>
    )
  }

  const silent = !hasLivePath(state, track.id)

  return (
    <div className="rg-root" data-ping-id={`routing:${track.id}`} data-ping={`routing graph · "${track.name}"`}>
      <div className="rg-toolbar">
        <AddPluginCard track={track} inserts={inserts} compact />
        <span className="statusbar-dim">
          Drag a port to connect · click a wire and press Del (or right-click it) to cut · drag
          nodes to arrange · Ctrl+wheel zooms · hold middle mouse to pan
        </span>
        {zoom !== 1 && (
          <button
            className="bay-btn"
            title="Reset zoom (Ctrl+wheel to zoom)"
            onClick={() => setZoom(1)}
          >
            {Math.round(zoom * 100)}%
          </button>
        )}
        {silent && (
          <span className="rg-warning">No path from In to Mix Out — this track is silent</span>
        )}
        <button
          className="bay-btn"
          title="Remove all wiring and return to the ordered rack chain"
          onClick={backToChain}
        >
          Back to chain
        </button>
      </div>
      <div
        className="rg-canvas"
        ref={canvasRef}
        data-pan
        tabIndex={0}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onKeyDown={onKeyDown}
        onPointerDown={() => setSelectedWire(null)}
      >
        {/* The sizer keeps scrollbars honest: transforms don't affect layout. */}
        <div style={{ width: contentW * zoom, height: contentH * zoom }}>
        <div
          className="rg-content"
          style={{
            width: contentW,
            height: contentH,
            transform: zoom === 1 ? undefined : `scale(${zoom})`,
            transformOrigin: '0 0'
          }}
        >
          <svg className="rg-wires" width={contentW} height={contentH}>
            {routes.map((route) => {
              const a = portPos(route.from, 'out')
              const b = portPos(route.to, 'in')
              const bend = Math.max(32, (b.x - a.x) / 2)
              const d = `M ${a.x} ${a.y} C ${a.x + bend} ${a.y}, ${b.x - bend} ${b.y}, ${b.x} ${b.y}`
              return (
                <g key={route.id}>
                  <path
                    className={`rg-wire ${selectedWire === route.id ? 'rg-wire-selected' : ''}`}
                    d={d}
                  />
                  <path
                    className="rg-wire-hit"
                    d={d}
                    onPointerDown={(e) => {
                      e.stopPropagation()
                      setSelectedWire(route.id)
                    }}
                    onContextMenu={(e) => {
                      e.preventDefault()
                      deleteWire(route.id)
                    }}
                  >
                    <title>Click to select, Del or right-click to cut</title>
                  </path>
                </g>
              )
            })}
            {wireDrag &&
              (() => {
                const a = portPos(wireDrag.from, 'out')
                const bend = Math.max(32, (wireDrag.x - a.x) / 2)
                return (
                  <path
                    className="rg-wire rg-wire-drag"
                    d={`M ${a.x} ${a.y} C ${a.x + bend} ${a.y}, ${wireDrag.x - bend} ${wireDrag.y}, ${wireDrag.x} ${wireDrag.y}`}
                  />
                )
              })()}
          </svg>

          {/* Live signal riding each wire: the audio AS IT LEAVES the wire's
              source node, so the shape visibly transforms effect by effect. */}
          {routes.map((route) => {
            const a = portPos(route.from, 'out')
            const b = portPos(route.to, 'in')
            const bend = Math.max(32, (b.x - a.x) / 2)
            return (
              <WireScope
                key={`scope:${route.id}`}
                trackId={track.id}
                from={route.from}
                x={(a.x + 3 * (a.x + bend) + 3 * (b.x - bend) + b.x) / 8
                }
                y={(a.y + 3 * a.y + 3 * b.y + b.y) / 8}
              />
            )
          })}

          <GraphTerminal
            name="In"
            pos={positions.get('in')!}
            onBeginWire={(e) => beginWire(e, 'in')}
            onBeginDrag={(e) => beginNodeDrag(e, 'in')}
          />
          <GraphTerminal
            name="Mix Out"
            pos={positions.get('out')!}
            inPort
            onBeginDrag={(e) => beginNodeDrag(e, 'out')}
          />

          {inserts.map((instance) => {
            const p = positions.get(instance.id)!
            return (
              <div
                key={instance.id}
                className={`rg-node ${instance.enabled ? '' : 'rg-node-bypassed'}`}
                style={{ left: p.x, top: p.y, width: NODE_W, height: NODE_H }}
                onPointerDown={(e) => beginNodeDrag(e, instance.id)}
              >
                <div className="rg-port rg-port-in" data-graph-in={instance.id} title="Audio in" />
                <div className="rg-node-name" title={instance.descriptor.name}>
                  {instance.descriptor.name}
                </div>
                <div className="rg-node-controls">
                  <button
                    className={`fx-power ${instance.enabled ? 'fx-power-on' : ''}`}
                    title={instance.enabled ? 'Bypass (signal passes through)' : 'Enable'}
                    onClick={() =>
                      projectStore.dispatch({
                        type: 'plugin/setEnabled',
                        instanceId: instance.id,
                        enabled: !instance.enabled
                      })
                    }
                  >
                    ⏻
                  </button>
                  <button
                    className="fx-remove rg-node-remove"
                    title={`Remove ${instance.descriptor.name} (its wires go with it)`}
                    onClick={() =>
                      projectStore.dispatch({ type: 'plugin/remove', instanceId: instance.id })
                    }
                  >
                    ×
                  </button>
                </div>
                <div
                  className="rg-port rg-port-out"
                  title="Audio out — drag to another node's input"
                  onPointerDown={(e) => beginWire(e, instance.id)}
                />
              </div>
            )
          })}
        </div>
        </div>
      </div>
    </div>
  )
}

const SCOPE_W = 64
const SCOPE_H = 22

/**
 * A little oscilloscope riding one wire, drawing the live waveform at the
 * wire's source — the track input for 'in', or the source insert's own
 * analyser tap. Painted in a rAF loop straight to the canvas (no React),
 * flat-lining when nothing plays or the source has no live nodes.
 */
function WireScope({
  trackId,
  from,
  x,
  y
}: {
  trackId: string
  from: NodeKey
  x: number
  y: number
}): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    let raf = 0
    let buf: Float32Array<ArrayBuffer> | null = null
    const gate = newPaintGate()
    const ink =
      getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#5b8def'
    const draw = (): void => {
      raf = requestAnimationFrame(draw)
      // Live trace only while the transport rolls; stopped scopes settle
      // to a flat line at the idle repaint rate instead of polling
      // analysers at 60 fps per wire forever.
      if (!shouldPaint(gate, null)) return
      const canvas = canvasRef.current
      const g = canvas?.getContext('2d')
      if (!canvas || !g) return
      const w = canvas.width
      const h = canvas.height
      g.clearRect(0, 0, w, h)
      g.strokeStyle = ink
      g.lineWidth = 1.2
      g.beginPath()
      const analyser = audioEngine.graphSourceAnalyser(trackId, from === 'out' ? 'in' : from)
      if (analyser) {
        if (!buf || buf.length !== analyser.fftSize) buf = new Float32Array(analyser.fftSize)
        analyser.getFloatTimeDomainData(buf)
        for (let px = 0; px < w; px++) {
          const v = buf[Math.floor((px / w) * buf.length)]
          const py = h / 2 - v * (h / 2 - 1)
          if (px === 0) g.moveTo(px, py)
          else g.lineTo(px, py)
        }
      } else {
        g.moveTo(0, h / 2)
        g.lineTo(w, h / 2)
      }
      g.stroke()
    }
    draw()
    return () => cancelAnimationFrame(raf)
  }, [trackId, from])

  return (
    <canvas
      ref={canvasRef}
      className="rg-wire-scope"
      width={SCOPE_W}
      height={SCOPE_H}
      style={{ left: x - SCOPE_W / 2, top: y - SCOPE_H / 2 }}
    />
  )
}

/** The In / Mix Out endpoints of every track graph — draggable like nodes. */
function GraphTerminal({
  name,
  pos,
  inPort = false,
  onBeginWire,
  onBeginDrag
}: {
  name: string
  pos: { x: number; y: number }
  inPort?: boolean
  onBeginWire?: (e: React.PointerEvent) => void
  onBeginDrag?: (e: React.PointerEvent) => void
}): React.JSX.Element {
  return (
    <div
      className="rg-node rg-node-terminal"
      style={{ left: pos.x, top: pos.y, width: NODE_W, height: NODE_H }}
      title="Drag to place — lay the tree out however the plugins fit"
      onPointerDown={onBeginDrag}
    >
      {inPort && (
        <div
          className="rg-port rg-port-in"
          data-graph-in="out"
          title="Everything arriving here is summed into the track's mix"
        />
      )}
      <div className="rg-node-name">{name}</div>
      {!inPort && (
        <div
          className="rg-port rg-port-out"
          title="The track's source — clips and instrument"
          onPointerDown={onBeginWire}
        />
      )}
    </div>
  )
}
