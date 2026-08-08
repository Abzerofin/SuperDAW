import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { PluginInstance, PluginInstanceId, Track } from '@core/model/types'
import { pluginsOfTrack } from '@core/model/types'
import { SYNTH_DEFS, WAVE_TYPES, synthDefaults, type ParamDef } from '@core/model/effects'
import type { PluginDescriptor } from '@core/plugins/descriptor'
import { BUILTIN_EFFECT_DESCRIPTORS, paramDefsOf, pluginDefaults } from '@core/plugins/builtin'
import { pluginRegistry } from '@audio/pluginRegistry'
import { newId } from '@core/model/ids'
import { projectStore } from '@/state/projectStore'
import { useProjectState } from '@/state/hooks'
import { usePluginRegistry } from '@/state/pluginRegistryHook'
import { audioEngine } from '@/state/audioInstance'
import { useSelectedTrackId } from '@/state/selection'
import {
  externalHostAvailable,
  externalParamDefs,
  externalPlugins,
  externalScanError,
  hasScanned,
  scanExternalPlugins,
  subscribeExternalPlugins,
  type ExternalPluginEntry
} from '@/state/externalPlugins'
import { capturePointer } from '@/lib/pointer'
import { wireEditorEvents } from '@/state/vst3Editors'
import { useVst3Dock, vst3Dock } from '@/state/vst3Dock'
import { PluginPlaceholder } from './PluginPlaceholder'

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

  /** Does this insert render its plugin's own GUI (vs generic sliders)? */
  const isGuiInsert = (instance: PluginInstance): boolean =>
    pluginRegistry.status(instance.descriptor) === 'offline' && !dock.isFailed(instance.id)

  // Docked GUIs need more than the dock's 240px: grow to the tallest one
  // (capped so the timeline keeps meaningful height).
  const guiHeights = inserts
    .map((i) => (isGuiInsert(i) ? (dock.dims(i.id)?.height ?? 0) : 0))
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
    e.preventDefault()
    capturePointer(e)
    setDrag({ id, order: inserts.map((p) => p.id) })
  }

  const moveDrag = (e: React.PointerEvent): void => {
    if (!drag || !chainRef.current) return
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

  const endDrag = (): void => {
    if (!drag) return
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
      </div>
      <div className="fx-dock-chain" ref={chainRef}>
        {track.kind === 'midi' && (
          <div className="fx-card">
            <SynthSection track={track} />
          </div>
        )}
        {shown.map((instance) => (
          <div
            key={instance.id}
            className={`fx-card fx-insert ${drag?.id === instance.id ? 'fx-insert-dragging' : ''} ${
              isGuiInsert(instance) ? 'fx-card-expanded' : ''
            }`}
          >
            <button
              className="fx-grip"
              title="Drag to reorder"
              onPointerDown={(e) => startDrag(e, instance.id)}
              onPointerMove={moveDrag}
              onPointerUp={endDrag}
              onPointerCancel={endDrag}
            >
              ⠿
            </button>
            <div className="fx-insert-body">
              <PluginSection instance={instance} />
            </div>
          </div>
        ))}
        <AddPluginCard track={track} inserts={inserts} />
      </div>
    </div>
  )
}

/** The "+" card: the entire plugin base, searchable. */
function AddPluginCard({
  track,
  inserts
}: {
  track: Track
  inserts: PluginInstance[]
}): React.JSX.Element {
  const [query, setQuery] = useState('')
  const rootRef = useRef<HTMLDivElement>(null)
  const browserRef = useRef<HTMLDivElement>(null)
  /** Where the popover anchors (viewport coords); null = closed. */
  const [anchor, setAnchor] = useState<{ left: number; bottom: number } | null>(null)
  const open = anchor !== null
  const [external, setExternal] = useState(externalPlugins)

  useEffect(() => {
    const unsubscribe = subscribeExternalPlugins(() => setExternal(externalPlugins()))
    if (!hasScanned()) void scanExternalPlugins()
    return unsubscribe
  }, [])

  useEffect(() => {
    if (!open) return
    // The popover is PORTALLED to <body> (an overflow ancestor would clip
    // it inside the dock), so "outside" means outside the card AND the
    // portalled panel.
    const onPointerDown = (e: PointerEvent): void => {
      const target = e.target as Node
      if (!rootRef.current?.contains(target) && !browserRef.current?.contains(target)) {
        setAnchor(null)
      }
    }
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setAnchor(null)
    }
    window.addEventListener('pointerdown', onPointerDown, true)
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  const addPlugin = (descriptor: PluginDescriptor): void => {
    const maxRank = inserts.reduce((max, p) => Math.max(max, p.rank), 0)
    projectStore.dispatch({
      type: 'plugin/add',
      instance: {
        id: newId('plg'),
        trackId: track.id,
        descriptor,
        enabled: true,
        rank: maxRank + 1,
        params: pluginDefaults(descriptor),
        stateBlob: null
      }
    })
    setAnchor(null)
    setQuery('')
  }

  const addVst3 = async (plugin: ExternalPluginEntry): Promise<void> => {
    // Snapshot the plugin's parameters into the descriptor at add-time,
    // so every peer clamps identically — including peers that do not have
    // the plugin installed at all.
    const paramDefs = await externalParamDefs(plugin.uid)
    addPlugin({
      format: 'vst3',
      uid: plugin.uid,
      name: plugin.name,
      vendor: plugin.vendor,
      version: plugin.version,
      ...(paramDefs && Object.keys(paramDefs).length > 0 ? { paramDefs } : {})
    })
  }

  const q = query.trim().toLowerCase()
  const matches = (name: string, vendor = ''): boolean =>
    q === '' || name.toLowerCase().includes(q) || vendor.toLowerCase().includes(q)

  const builtins = BUILTIN_EFFECT_DESCRIPTORS.filter((d) => matches(d.name))
  // Effects only: instruments ignore audio input, and the insert chain is
  // not where they belong.
  const vst3Effects = external.filter(
    (p) => p.subCategories.startsWith('Fx') && matches(p.name, p.vendor)
  )
  const vst3Reason = !externalHostAvailable()
    ? 'VST3 · desktop app only (npm run dev)'
    : (externalScanError() ?? (external.length === 0 ? 'VST3 · no effects found' : null))

  const toggle = (e: React.MouseEvent): void => {
    if (open) {
      setAnchor(null)
      return
    }
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    setAnchor({
      // Keep the 280px panel on screen even when the + card sits at the
      // right edge of the chain.
      left: Math.max(8, Math.min(rect.left, window.innerWidth - 288)),
      bottom: window.innerHeight - rect.top + 4
    })
  }

  return (
    <div className="fx-card fx-add-card" ref={rootRef}>
      <button className="fx-add-open" title="Add an effect" onClick={toggle}>
        +
      </button>
      {anchor &&
        createPortal(
          <div
            className="fx-browser"
            ref={browserRef}
            style={{ left: anchor.left, bottom: anchor.bottom }}
            onPointerDown={(e) => e.stopPropagation()}
          >
          <input
            className="fx-browser-search"
            placeholder="Search plugins…"
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <div className="fx-browser-list">
            {builtins.length > 0 && <div className="fx-browser-group statusbar-dim">Built-in</div>}
            {builtins.map((descriptor) => (
              <button
                key={descriptor.uid}
                className="fx-browser-item"
                onClick={() => addPlugin(descriptor)}
              >
                <span>{descriptor.name}</span>
                <span className="statusbar-dim">SuperDAW</span>
              </button>
            ))}
            {(vst3Effects.length > 0 || vst3Reason) && (
              <div className="fx-browser-group statusbar-dim">
                {vst3Reason ?? 'VST3 · rendered ahead during playback'}
              </div>
            )}
            {vst3Effects.map((plugin) => (
              <button
                key={plugin.uid}
                className="fx-browser-item"
                title={`${plugin.vendor} · ${plugin.version}`}
                onClick={() => void addVst3(plugin)}
              >
                <span>{plugin.name}</span>
                <span className="statusbar-dim">{plugin.vendor}</span>
              </button>
            ))}
            {builtins.length === 0 && vst3Effects.length === 0 && (
              <div className="bay-empty">No plugins match “{query}”</div>
            )}
          </div>
        </div>,
          document.body
        )}
    </div>
  )
}

function SynthSection({ track }: { track: Track }): React.JSX.Element {
  const params = { ...synthDefaults(), ...track.synth }
  const setParam = (param: string, value: number): void => {
    projectStore.dispatch({ type: 'track/setSynthParam', trackId: track.id, param, value })
  }

  return (
    <div className="fx-section">
      <div className="fx-section-head">
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
      </div>
      {Object.entries(SYNTH_DEFS)
        .filter(([key]) => key !== 'wave')
        .map(([key, def]) => (
          <ParamSlider key={key} def={def} value={params[key]} onCommit={(v) => setParam(key, v)} />
        ))}
    </div>
  )
}

function PluginSection({ instance }: { instance: PluginInstance }): React.JSX.Element {
  usePluginRegistry() // re-render when a plugin gets installed mid-session
  const dock = useVst3Dock()
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
  const defs = guiMode ? {} : (paramDefsOf(instance.descriptor) ?? {})
  return (
    <div className={`fx-section ${instance.enabled ? '' : 'fx-bypassed'}`}>
      <div className="fx-section-head">
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
          className="comment-delete fx-remove"
          title="Remove plugin"
          onClick={() => projectStore.dispatch({ type: 'plugin/remove', instanceId: instance.id })}
        >
          ×
        </button>
      </div>
      {Object.entries(defs).map(([key, paramDef]) => (
        <ParamSlider
          key={key}
          def={paramDef}
          value={instance.params[key] ?? paramDef.default}
          // No live preview for out-of-process plugins: there are no nodes
          // in the graph to push a value into.
          onPreview={
            offline ? undefined : (v) => audioEngine.previewPluginParam(instance.id, key, v)
          }
          onCommit={(v) =>
            projectStore.dispatch({
              type: 'plugin/setParam',
              instanceId: instance.id,
              param: key,
              value: v
            })
          }
        />
      ))}
      {guiMode && <DockedEditor instance={instance} />}
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
      const chain = holder?.closest('.fx-dock-chain')
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

const SLIDER_W = 116

function ParamSlider({
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
