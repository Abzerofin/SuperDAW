import { useEffect, useRef, useState } from 'react'
import type { Effect, Track } from '@core/model/types'
import { effectsOfTrack } from '@core/model/types'
import {
  EFFECT_DEFS,
  EFFECT_TYPES,
  SYNTH_DEFS,
  WAVE_TYPES,
  effectDefaults,
  synthDefaults,
  type EffectType,
  type ParamDef
} from '@core/model/effects'
import { newId } from '@core/model/ids'
import { projectStore } from '@/state/projectStore'
import { useProjectState } from '@/state/hooks'
import { audioEngine } from '@/state/audioInstance'
import { fxUi } from '@/state/fxUi'
import { capturePointer } from '@/lib/pointer'

/**
 * Per-track FX panel: the built-in synth's controls (MIDI tracks) and the
 * insert chain (add, bypass, remove, tweak). Knobs preview live through
 * the engine and dispatch ONE op on release.
 */
export function FxPanel({ track }: { track: Track }): React.JSX.Element {
  const state = useProjectState()
  const rootRef = useRef<HTMLDivElement>(null)
  const inserts = effectsOfTrack(state, track.id)

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

  const addEffect = (type: EffectType): void => {
    const maxRank = inserts.reduce((max, e) => Math.max(max, e.rank), 0)
    projectStore.dispatch({
      type: 'effect/add',
      effect: {
        id: newId('efx'),
        trackId: track.id,
        type,
        enabled: true,
        rank: maxRank + 1,
        params: effectDefaults(type)
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

        {inserts.map((effect) => (
          <EffectSection key={effect.id} effect={effect} />
        ))}

        <div className="fx-add">
          {EFFECT_TYPES.map((type) => (
            <button key={type} className="fx-add-btn" onClick={() => addEffect(type)}>
              + {EFFECT_DEFS[type].label}
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

function EffectSection({ effect }: { effect: Effect }): React.JSX.Element {
  const def = EFFECT_DEFS[effect.type]
  return (
    <div className={`fx-section ${effect.enabled ? '' : 'fx-bypassed'}`}>
      <div className="fx-section-head">
        <button
          className={`fx-power ${effect.enabled ? 'fx-power-on' : ''}`}
          title={effect.enabled ? 'Bypass' : 'Enable'}
          onClick={() =>
            projectStore.dispatch({
              type: 'effect/setEnabled',
              effectId: effect.id,
              enabled: !effect.enabled
            })
          }
        >
          ⏻
        </button>
        <span className="fx-section-title">{def.label}</span>
        <button
          className="comment-delete fx-remove"
          title="Remove effect"
          onClick={() => projectStore.dispatch({ type: 'effect/remove', effectId: effect.id })}
        >
          ×
        </button>
      </div>
      {Object.entries(def.params).map(([key, paramDef]) => (
        <ParamSlider
          key={key}
          def={paramDef}
          value={effect.params[key] ?? paramDef.default}
          onPreview={(v) => audioEngine.previewEffectParam(effect.id, key, v)}
          onCommit={(v) =>
            projectStore.dispatch({
              type: 'effect/setParam',
              effectId: effect.id,
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
