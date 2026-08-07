import { useEffect, useRef, useState } from 'react'
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
import { fxUi } from '@/state/fxUi'
import {
  externalParamDefs,
  externalPlugins,
  hasScanned,
  scanExternalPlugins,
  subscribeExternalPlugins
} from '@/state/externalPlugins'
import { capturePointer } from '@/lib/pointer'
import { PluginPlaceholder } from './PluginPlaceholder'

/**
 * Per-track FX panel: the built-in synth's controls (MIDI tracks) and the
 * insert chain (add, bypass, remove, tweak). Knobs preview live through
 * the engine and dispatch ONE op on release.
 */
export function FxPanel({ track }: { track: Track }): React.JSX.Element {
  const state = useProjectState()
  const rootRef = useRef<HTMLDivElement>(null)
  const insertsRef = useRef<HTMLDivElement>(null)
  const inserts = pluginsOfTrack(state, track.id)

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
    if (!drag || !insertsRef.current) return
    // Rows are rendered in the previewed order, so crossing a row's
    // midpoint is what moves the dragged insert into that slot.
    const rows = Array.from(insertsRef.current.children)
    let target = rows.length - 1
    for (let i = 0; i < rows.length; i++) {
      const rect = rows[i].getBoundingClientRect()
      if (e.clientY < rect.top + rect.height / 2) {
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

  useEffect(() => {
    const onPointerDown = (e: PointerEvent): void => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) fxUi.close()
    }
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') fxUi.close()
    }
    window.addEventListener('pointerdown', onPointerDown, true)
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [])

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
  }

  return (
    <div className="fx-panel" ref={rootRef} onPointerDown={(e) => e.stopPropagation()}>
      <div className="fx-head">
        <span className="fx-title">
          <span className="proll-dot" style={{ background: track.color }} />
          {track.name}
        </span>
        <button className="proll-close" title="Close (Esc)" onClick={() => fxUi.close()}>
          ×
        </button>
      </div>

      <div className="fx-body">
        {track.kind === 'midi' && <SynthSection track={track} />}

        <div className="fx-inserts" ref={insertsRef}>
          {shown.map((instance) => (
            <div
              key={instance.id}
              className={`fx-insert ${drag?.id === instance.id ? 'fx-insert-dragging' : ''}`}
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
        </div>

        <div className="fx-add">
          {BUILTIN_EFFECT_DESCRIPTORS.map((descriptor) => (
            <button
              key={descriptor.uid}
              className="fx-add-btn"
              onClick={() => addPlugin(descriptor)}
            >
              + {descriptor.name}
            </button>
          ))}
        </div>

        <Vst3Picker onAdd={addPlugin} />
      </div>
    </div>
  )
}

/**
 * Installed VST3 effects. They cannot run in the renderer's audio graph
 * (see native/README.md), so an added one shows as a placeholder until the
 * track is frozen — which is where its audio is actually rendered. The
 * copy says so rather than letting it look broken.
 */
function Vst3Picker({
  onAdd
}: {
  onAdd: (descriptor: PluginDescriptor) => void
}): React.JSX.Element | null {
  const [plugins, setPlugins] = useState(externalPlugins)

  useEffect(() => {
    const unsubscribe = subscribeExternalPlugins(() => setPlugins(externalPlugins()))
    if (!hasScanned()) void scanExternalPlugins()
    return unsubscribe
  }, [])

  // Effects only: instruments ignore audio input, and the insert chain is
  // not where they belong.
  const effects = plugins.filter((p) => p.subCategories.startsWith('Fx'))
  if (effects.length === 0) return null

  return (
    <div className="fx-add fx-add-vst3">
      <div className="fx-add-label statusbar-dim">VST3 · rendered on freeze</div>
      {effects.map((plugin) => (
        <button
          key={plugin.uid}
          className="fx-add-btn"
          title={`${plugin.vendor} · ${plugin.version}`}
          onClick={async () => {
            // Snapshot the plugin's parameters into the descriptor at
            // add-time, so every peer clamps identically — including peers
            // that do not have the plugin installed at all.
            const paramDefs = await externalParamDefs(plugin.uid)
            onAdd({
              format: 'vst3',
              uid: plugin.uid,
              name: plugin.name,
              vendor: plugin.vendor,
              version: plugin.version,
              ...(paramDefs && Object.keys(paramDefs).length > 0 ? { paramDefs } : {})
            })
          }}
        >
          + {plugin.name}
        </button>
      ))}
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
          <ParamSlider
            key={key}
            def={def}
            value={params[key]}
            onCommit={(v) => setParam(key, v)}
          />
        ))}
    </div>
  )
}

function PluginSection({ instance }: { instance: PluginInstance }): React.JSX.Element {
  usePluginRegistry() // re-render when a plugin gets installed mid-session
  const status = pluginRegistry.status(instance.descriptor)
  // 'offline' plugins (VST3) are installed here but hosted out of process:
  // their params ARE editable, they just cannot be previewed live, so they
  // get real controls rather than a placeholder.
  if (status !== 'local' && status !== 'offline') {
    return <PluginPlaceholder instance={instance} status={status} />
  }
  const offline = status === 'offline'
  const defs = paramDefsOf(instance.descriptor) ?? {}
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
            title="Hosted out of process: heard once the track is frozen, not during live playback"
          >
            ❄ on freeze
          </span>
        )}
        <button
          className="comment-delete fx-remove"
          title="Remove plugin"
          onClick={() =>
            projectStore.dispatch({ type: 'plugin/remove', instanceId: instance.id })
          }
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
    </div>
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
