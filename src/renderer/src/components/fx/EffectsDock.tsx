import { useEffect, useRef, useState } from 'react'
import type { PluginInstance, PluginInstanceId, Track } from '@core/model/types'
import { pluginsOfTrack, routesOfTrack } from '@core/model/types'
import {
  SYNTH_DEFS,
  SYNTH_STATE_PARAMS,
  WAVE_TYPES,
  synthDefaults
} from '@core/model/effects'
import { builtinTypeOf, paramDefsOf, pluginDefaults } from '@core/plugins/builtin'
import { pluginRegistry } from '@audio/pluginRegistry'
import { projectStore } from '@/state/projectStore'
import { useProjectState } from '@/state/hooks'
import { usePluginRegistry } from '@/state/pluginRegistryHook'
import { audioEngine } from '@/state/audioInstance'
import { useSelectedTrackId } from '@/state/selection'
import { capturePointer } from '@/lib/pointer'
import { wireEditorEvents } from '@/state/vst3Editors'
import { useVst3Dock, vst3Dock } from '@/state/vst3Dock'
import { useFxUi } from '@/state/fxUi'
import { fxFloatUi, useFxFloatUi } from '@/state/fxFloatUi'
import { AddPluginCard } from './AddPluginCard'
import { historyUi } from '@/state/historyUi'
import { PluginPlaceholder } from './PluginPlaceholder'
import { EffectVisual } from './PluginVisuals'
import { ParamSlider } from './ParamSlider'
import { RoutingGraph } from './RoutingGraph'

/**
 * The Effects tab of the bottom dock: the SELECTED track's synth (MIDI)
 * and insert chain as a horizontal rack, plus a "+" card that browses the
 * whole plugin base (builtins and every installed VST3 effect). Replaces
 * the old per-track FX popup. Knobs preview live through the engine and
 * dispatch ONE op on release.
 */
export function EffectsDock(): React.JSX.Element {
  const state = useProjectState()
  const selectedTrackId = useSelectedTrackId()
  const track = selectedTrackId ? state.tracks[selectedTrackId] : undefined

  if (!track) {
    return (
      <div className="fx-dock">
        <div className="bay-empty">Select a track to edit its effects</div>
      </div>
    )
  }
  // Keyed by track so drag state can never leak across a selection change.
  return <TrackEffects key={track.id} track={track} />
}

function TrackEffects({ track }: { track: Track }): React.JSX.Element {
  const state = useProjectState()
  const chainRef = useRef<HTMLDivElement>(null)
  const inserts = pluginsOfTrack(state, track.id)
  const dock = useVst3Dock()
  const fxCollapse = useFxUi()
  const fxFloat = useFxFloatUi()
  // Rack = the classic ordered chain; Graph = node routing. Tracks that
  // already have routing edges open on their graph.
  const [view, setView] = useState<'rack' | 'graph'>(() =>
    routesOfTrack(projectStore.state, track.id).length > 0 ? 'graph' : 'rack'
  )

  /** Does this insert render its plugin's own GUI (vs generic sliders)? */
  const isGuiInsert = (instance: PluginInstance): boolean =>
    pluginRegistry.status(instance.descriptor) === 'offline' && !dock.isFailed(instance.id)

  // Docked GUIs need more than the dock's 240px: grow to the tallest one
  // (capped so the timeline keeps meaningful height).
  const guiHeights = inserts
    .map((i) => (isGuiInsert(i) && !fxFloat.isFloating(i.id) ? (dock.dims(i.id)?.height ?? 0) : 0))
    .filter((h) => h > 0)
  const dockHeight =
    guiHeights.length > 0
      ? Math.min(
          Math.max(240, Math.max(...guiHeights) + 92),
          Math.round(window.innerHeight * 0.7)
        )
      : undefined

  // Reorder drag: the previewed order lives here and only becomes a
  // plugin/reorder op on release (one gesture = one operation).
  const [drag, setDrag] = useState<{ id: PluginInstanceId; order: PluginInstanceId[] } | null>(null)
  const byId = new Map(inserts.map((p) => [p.id, p]))
  const shown = drag
    ? drag.order.map((id) => byId.get(id)).filter((p): p is PluginInstance => p !== undefined)
    : inserts

  const startDrag = (e: React.PointerEvent, id: PluginInstanceId): void => {
    if (e.button !== 0) return
    // The header doubles as a drag handle, so a press on one of its own
    // controls (power, remove) must stay a click. The grip itself IS the
    // handle, hence the currentTarget exemption.
    const button = (e.target as HTMLElement).closest('button')
    if (button && button !== e.currentTarget) return
    e.preventDefault()
    capturePointer(e)
    setDrag({ id, order: inserts.map((p) => p.id) })
  }

  /** Pointer props that make an element a reorder handle for one insert. */
  const dragHandle = (id: PluginInstanceId): React.HTMLAttributes<HTMLElement> => ({
    onPointerDown: (e) => startDrag(e, id),
    onPointerMove: moveDrag,
    onPointerUp: endDrag,
    // A cancelled pointer has no meaningful coords — never undock from it.
    onPointerCancel: () => endDrag()
  })

  /** Is the pointer outside the whole Effects dock (an undock gesture)? */
  const outsideDock = (e: React.PointerEvent): boolean => {
    const dockEl = chainRef.current?.closest('.fx-dock')
    if (!dockEl) return false
    const rect = dockEl.getBoundingClientRect()
    return (
      e.clientX < rect.left || e.clientX > rect.right || e.clientY < rect.top || e.clientY > rect.bottom
    )
  }

  const moveDrag = (e: React.PointerEvent): void => {
    if (!drag || !chainRef.current) return
    // Off the dock the gesture is an undock, not a reorder — freeze the
    // previewed order so cards stop shuffling under a departing pointer.
    if (outsideDock(e)) return
    // Cards are rendered in the previewed order; crossing a card's
    // horizontal midpoint moves the dragged insert into that slot.
    const cards = Array.from(chainRef.current.querySelectorAll('.fx-insert'))
    if (cards.length === 0) return
    let target = cards.length - 1
    for (let i = 0; i < cards.length; i++) {
      const rect = cards[i].getBoundingClientRect()
      if (e.clientX < rect.left + rect.width / 2) {
        target = i
        break
      }
    }
    const from = drag.order.indexOf(drag.id)
    if (from === -1 || from === target) return
    const order = [...drag.order]
    order.splice(target, 0, ...order.splice(from, 1))
    setDrag({ ...drag, order })
  }

  const endDrag = (e?: React.PointerEvent): void => {
    if (!drag) return
    // Dropped off the panel: undock into a floating window under the cursor.
    if (e && outsideDock(e)) {
      fxFloatUi.float(drag.id, e.clientX - 125, e.clientY - 14)
      setDrag(null)
      return
    }
    const before = inserts.map((p) => p.id)
    if (drag.order.some((id, i) => id !== before[i])) {
      projectStore.dispatch({ type: 'plugin/reorder', trackId: track.id, order: drag.order })
    }
    setDrag(null)
  }

  return (
    <div className="fx-dock" style={dockHeight !== undefined ? { height: dockHeight } : undefined}>
      <div className="fx-dock-head">
        <span className="proll-dot" style={{ background: track.color }} />
        <span className="fx-dock-title">{track.name}</span>
        <span className="statusbar-dim">
          {track.kind === 'folder' ? 'bus effects' : track.kind === 'midi' ? 'instrument & effects' : 'effects'}
        </span>
        {track.frozenAssetId && (
          <span className="statusbar-dim">· frozen — inserts baked into the render</span>
        )}
        {view === 'rack' && routesOfTrack(state, track.id).length > 0 && (
          <span className="statusbar-dim" title="With graph routing on, the audible order is the graph's wiring — the rack is just a linked list of this track's effects">
            · graph routing on — signal order lives in the Graph
          </span>
        )}
        <div className="fx-view-toggle">
          <button
            className={`bay-btn ${view === 'rack' ? 'fx-view-active' : ''}`}
            title="The ordered effect rack"
            onClick={() => setView('rack')}
          >
            Rack
          </button>
          <button
            className={`bay-btn ${view === 'graph' ? 'fx-view-active' : ''}`}
            title="Node routing — branch and merge effect paths"
            onClick={() => setView('graph')}
          >
            Graph
          </button>
        </div>
      </div>
      {view === 'graph' && <RoutingGraph track={track} />}
      {view === 'rack' && (
      <div className="fx-dock-chain" ref={chainRef} data-pan>
        {track.kind === 'midi' &&
          ((track.synth.present ?? 1) >= 0.5 ? (
            <div className="fx-card">
              <SynthSection track={track} />
            </div>
          ) : (
            <AddSynthCard track={track} />
          ))}
        {shown.map((instance) =>
          fxFloat.isFloating(instance.id) ? (
            // Undocked: a slim stand-in keeps the device's place in the
            // chain visible; the real UI is in its floating window.
            <div key={instance.id} className="fx-card fx-insert fx-card-collapsed fx-float-placeholder">
              <div className="fx-insert-body">
                <div className="fx-section">
                  <div className="fx-section-head">
                    <span className="fx-section-title">{instance.descriptor.name}</span>
                    <button
                      className="fx-collapse"
                      title="Bring the floating window back into the rack"
                      onClick={() => fxFloatUi.dock(instance.id)}
                    >
                      ⇲
                    </button>
                  </div>
                </div>
              </div>
            </div>
          ) : (
          <div
            key={instance.id}
            className={`fx-card fx-insert ${drag?.id === instance.id ? 'fx-insert-dragging' : ''} ${
              fxCollapse.isCollapsed(instance.id)
                ? 'fx-card-collapsed'
                : `${isGuiInsert(instance) ? 'fx-card-expanded' : ''} ${
                    builtinTypeOf(instance.descriptor) === 'paraeq' ? 'fx-card-wide' : ''
                  }`
            }`}
          >
            <button className="fx-grip" title="Drag to reorder" {...dragHandle(instance.id)}>
              ⠿
            </button>
            <div className="fx-insert-body">
              <PluginSection instance={instance} dragHandle={dragHandle(instance.id)} />
            </div>
          </div>
          )
        )}
        <AddPluginCard track={track} inserts={inserts} />
      </div>
      )}
    </div>
  )
}

function SynthSection({ track }: { track: Track }): React.JSX.Element {
  const params = { ...synthDefaults(), ...track.synth }
  const setParam = (param: string, value: number): void => {
    projectStore.dispatch({ type: 'track/setSynthParam', trackId: track.id, param, value })
  }
  const enabled = params.on >= 0.5

  return (
    <div className={`fx-section ${enabled ? '' : 'fx-bypassed'}`}>
      <div className="fx-section-head">
        <button
          className={`fx-power ${enabled ? 'fx-power-on' : ''}`}
          title={enabled ? 'Bypass the instrument' : 'Enable the instrument'}
          onClick={() => setParam('on', enabled ? 0 : 1)}
        >
          ⏻
        </button>
        <span className="fx-section-title">Synth</span>
        <div className="fx-waves">
          {WAVE_TYPES.map((wave, index) => (
            <button
              key={wave}
              className={`fx-wave ${Math.round(params.wave) === index ? 'fx-wave-active' : ''}`}
              title={wave}
              onClick={() => setParam('wave', index)}
            >
              {['◺', '⊓', '△', '∿'][index]}
            </button>
          ))}
        </div>
        <button
          className="fx-remove"
          title="Remove the instrument from this track (its notes are kept)"
          onClick={() => setParam('present', 0)}
        >
          ×
        </button>
      </div>
      {Object.entries(SYNTH_DEFS)
        .filter(([key]) => key !== 'wave' && !SYNTH_STATE_PARAMS.includes(key as 'on' | 'present'))
        .map(([key, def]) => (
          <ParamSlider key={key} def={def} value={params[key]} onCommit={(v) => setParam(key, v)} />
        ))}
    </div>
  )
}

/** What stands in for a removed instrument: one click puts it back. */
function AddSynthCard({ track }: { track: Track }): React.JSX.Element {
  return (
    <div className="fx-card fx-add-card">
      <button
        className="fx-add-open fx-add-open-text"
        title="Add the built-in instrument back to this track"
        // Re-adding gives a working instrument at its defaults, like adding
        // any other plugin — a removal that came back silent (or still
        // bypassed) would read as broken. Undo brings the old sound back.
        onClick={() =>
          projectStore.dispatch({
            type: 'track/setSynthParams',
            trackId: track.id,
            params: synthDefaults()
          })
        }
      >
        + Synth
      </button>
    </div>
  )
}

export function PluginSection({
  instance,
  dragHandle,
  floating = false
}: {
  instance: PluginInstance
  /** Makes the card header a drag handle: reorder in the rack, move when floating. */
  dragHandle?: React.HTMLAttributes<HTMLElement>
  /** Rendered in an undocked window (see FloatingEffects) — header gains a re-dock button. */
  floating?: boolean
}): React.JSX.Element {
  usePluginRegistry() // re-render when a plugin gets installed mid-session
  const dock = useVst3Dock()
  const fxCollapse = useFxUi()
  const collapsed = fxCollapse.isCollapsed(instance.id)
  // In-flight slider previews, so the card's visualization tracks a drag
  // before the plugin/setParam op lands on release.
  const [previewParams, setPreviewParams] = useState<Record<string, number>>({})
  const status = pluginRegistry.status(instance.descriptor)
  // 'offline' plugins (VST3) are installed here but hosted out of process:
  // their params ARE editable, they just cannot be previewed live, so they
  // get real controls rather than a placeholder.
  if (status !== 'local' && status !== 'offline') {
    return <PluginPlaceholder instance={instance} status={status} />
  }
  const offline = status === 'offline'
  // Every VST3 shows its own GUI automatically; generic sliders exist for
  // builtins and as the fallback when a plugin has no editor (or its
  // editor failed to open).
  const guiMode = offline && !dock.isFailed(instance.id)
  const builtinType = builtinTypeOf(instance.descriptor)
  // The parametric EQ's editor IS its controls — its 40 band params would
  // be unusable as a wall of generic sliders.
  const defs =
    guiMode || builtinType === 'paraeq' ? {} : (paramDefsOf(instance.descriptor) ?? {})
  return (
    <div className={`fx-section ${instance.enabled ? '' : 'fx-bypassed'}`}>
      <div
        className={`fx-section-head ${dragHandle ? 'fx-section-head-drag' : ''}`}
        title={dragHandle ? (floating ? 'Drag to move' : 'Drag to reorder · drop outside the dock to undock') : undefined}
        {...dragHandle}
      >
        <button
          className={`fx-power ${instance.enabled ? 'fx-power-on' : ''}`}
          title={instance.enabled ? 'Bypass' : 'Enable'}
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
        <span className="fx-section-title">{instance.descriptor.name}</span>
        {offline && (
          <span
            className="fx-offline-tag statusbar-dim"
            title="Hosted out of process: audible during playback via look-ahead rendering (a knob change takes a moment to be heard). Freeze for exact, low-latency playback."
          >
            VST3
          </span>
        )}
        <button
          className="fx-collapse"
          title="History — this insert's changes this session, each restorable"
          onClick={(e) => {
            const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
            historyUi.open({
              kind: 'plugin',
              id: instance.id,
              title: instance.descriptor.name,
              x: rect.left,
              y: rect.bottom + 4
            })
          }}
        >
          🕘
        </button>
        <button
          className="fx-collapse"
          title={collapsed ? 'Expand' : 'Collapse to just the header'}
          onClick={() => fxCollapse.toggleCollapsed(instance.id)}
        >
          {collapsed ? '▸' : '▾'}
        </button>
        {floating && (
          <button
            className="fx-collapse"
            title="Return to the effects rack"
            onClick={() => fxFloatUi.dock(instance.id)}
          >
            ⇱
          </button>
        )}
        <button
          className="fx-remove"
          title={`Remove ${instance.descriptor.name} from this track`}
          onClick={() => projectStore.dispatch({ type: 'plugin/remove', instanceId: instance.id })}
        >
          ×
        </button>
      </div>
      {!collapsed && builtinType && (
        <EffectVisual
          type={builtinType}
          instanceId={instance.id}
          params={{ ...pluginDefaults(instance.descriptor), ...instance.params, ...previewParams }}
        />
      )}
      {!collapsed &&
        Object.entries(defs).map(([key, paramDef]) => (
        <ParamSlider
          key={key}
          def={paramDef}
          value={instance.params[key] ?? paramDef.default}
          // No live preview for out-of-process plugins: there are no nodes
          // in the graph to push a value into.
          onPreview={
            offline
              ? undefined
              : (v) => {
                  audioEngine.previewPluginParam(instance.id, key, v)
                  setPreviewParams((p) => (p[key] === v ? p : { ...p, [key]: v }))
                }
          }
          onCommit={(v) => {
            projectStore.dispatch({
              type: 'plugin/setParam',
              instanceId: instance.id,
              param: key,
              value: v
            })
            setPreviewParams((p) => {
              if (!(key in p)) return p
              const next = { ...p }
              delete next[key]
              return next
            })
          }}
        />
      ))}
      {!collapsed && guiMode && <DockedEditor instance={instance} />}
    </div>
  )
}

/**
 * The reserved area a docked plugin GUI sits over. The native overlay is
 * positioned by tracking this div's viewport rect every frame (window
 * moves are handled main-side; this covers dock scroll, layout shifts and
 * resizes), clipped to the chain's scroll viewport so it cannot overhang.
 * Unmounting — collapse, track switch, tab close — collapses the editor,
 * which captures the plugin's state.
 */
function DockedEditor({ instance }: { instance: PluginInstance }): React.JSX.Element {
  const dims = useVst3Dock().dims(instance.id) ?? { width: 480, height: 320 }
  const holderRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const api = window.superdaw
    if (!api?.vst3DockEditor) return
    // Knob gestures and state captures from the plugin's own GUI arrive on
    // this channel; docked editors are the only thing that opens one now.
    wireEditorEvents()
    let raf = 0
    let lastSent = ''
    let cancelled = false

    const report = (): void => {
      raf = requestAnimationFrame(report)
      const holder = holderRef.current
      // The clip viewport: the rack's scrolling chain, or the floating
      // window's own frame when the device is undocked.
      const chain = holder?.closest('.fx-dock-chain, .fx-float')
      if (!holder || !chain) return
      const r = holder.getBoundingClientRect()
      // The chain's CLIENT box: its border box includes padding and the
      // horizontal scrollbar strip, and clipping to that lets the overlay
      // sit past the visual edge and cover the scrollbar. Clamp to the
      // window viewport too, so a shrunken window still cuts the GUI off.
      const cRect = chain.getBoundingClientRect()
      const el = chain as HTMLElement
      const viewport = {
        left: Math.max(cRect.left + el.clientLeft, 0),
        top: Math.max(cRect.top + el.clientTop, 0),
        right: Math.min(cRect.left + el.clientLeft + el.clientWidth, window.innerWidth),
        bottom: Math.min(cRect.top + el.clientTop + el.clientHeight, window.innerHeight)
      }
      const rect = {
        x: Math.round(r.left),
        y: Math.round(r.top),
        clipLeft: Math.round(Math.max(0, viewport.left - r.left)),
        clipTop: Math.round(Math.max(0, viewport.top - r.top)),
        clipRight: Math.round(Math.max(0, r.right - viewport.right)),
        clipBottom: Math.round(Math.max(0, r.bottom - viewport.bottom)),
        visible:
          r.width > 0 &&
          r.right > viewport.left &&
          r.left < viewport.right &&
          r.bottom > viewport.top &&
          r.top < viewport.bottom
      }
      const key = JSON.stringify(rect)
      if (key === lastSent) return
      lastSent = key
      void api
        .vst3DockEditor({
          instanceId: instance.id,
          uid: instance.descriptor.uid,
          stateBlob: instance.stateBlob,
          rect
        })
        .then((result) => {
          if (cancelled) return
          if (result.error) {
            // No editor (or a broken one): the card falls back to sliders.
            vst3Dock.markFailed(instance.id)
          } else if (result.width && result.height) {
            vst3Dock.setDims(instance.id, { width: result.width, height: result.height })
          }
        })
    }
    raf = requestAnimationFrame(report)

    return () => {
      cancelled = true
      cancelAnimationFrame(raf)
      // Collapse captures state (plugin/setState arrives via editor events).
      void api.vst3DockEditor({
        instanceId: instance.id,
        uid: instance.descriptor.uid,
        rect: null
      })
    }
    // stateBlob deliberately absent from deps: it changes as a RESULT of
    // collapsing, and reopening on every state capture would loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [instance.id, instance.descriptor.uid])

  return (
    <div
      className="fx-docked-editor"
      ref={holderRef}
      style={{ width: dims.width, height: dims.height }}
    />
  )
}

