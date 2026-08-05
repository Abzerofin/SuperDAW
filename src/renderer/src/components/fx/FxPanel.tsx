import { useEffect, useRef, useState } from 'react'
import type { PluginInstance, Track } from '@core/model/types'
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
  const inserts = pluginsOfTrack(state, track.id)

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

        {inserts.map((instance) => (
          <PluginSection key={instance.id} instance={instance} />
        ))}

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
      </div>
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
  if (status !== 'local') {
    return <PluginPlaceholder instance={instance} status={status} />
  }
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
          onPreview={(v) => audioEngine.previewPluginParam(instance.id, key, v)}
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
