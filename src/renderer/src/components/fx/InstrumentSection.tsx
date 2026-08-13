import { useState } from 'react'
import type { Track } from '@core/model/types'
import {
  DRUM_PADS,
  INSTRUMENT_KINDS,
  SYNTH_DEFS,
  WAVE_TYPES,
  instrumentKindOf,
  synthDefaults,
  type InstrumentKind
} from '@core/model/effects'
import { sliceRegions } from '@core/model/slices'
import { projectStore } from '@/state/projectStore'
import { assetStore } from '@/state/audioInstance'
import { auditionDown, auditionUp } from '@/lib/audition'
import { assetOnsets } from '@/lib/peakSnap'
import { BAY_DRAG_MIME, type BayDragPayload } from '@/lib/importAudio'
import { ParamSlider } from './ParamSlider'

/**
 * The instrument card on a note track: one of three built-in instruments —
 * the analog synth, the sampler, the drum kit — selected by the
 * `instrument` synth param. All params coexist in the one flat record, so
 * switching kinds never loses a knob position, and every control is the
 * ordinary track/setSynthParam op (undoable, synced, clamped in core).
 *
 * Which kinds a track may CHOOSE depends on its own kind, and the rule is
 * deliberately one-way: a drum track can reach for any of them (a kit
 * built from a sampler is still a kit), while a MIDI track cannot pick the
 * drum kit — that is what a drum track is for, and the piano roll is the
 * wrong surface to program one on. See `editorUi.autoFormForTrack`.
 */

const KIND_LABELS: Record<InstrumentKind, string> = {
  analog: 'Synth',
  sampler: 'Sampler',
  drums: 'Drum Kit'
}
const KIND_BADGES: Record<InstrumentKind, string> = { analog: 'SYN', sampler: 'SMP', drums: 'DRM' }

const ANALOG_PARAMS = ['cutoff', 'attack', 'decay', 'sustain', 'release', 'detune'] as const
const SAMPLER_ENVELOPE = ['smpAttack', 'smpDecay', 'smpSustain', 'smpRelease', 'smpGain'] as const

export function InstrumentSection({ track }: { track: Track }): React.JSX.Element {
  const params = { ...synthDefaults(), ...track.synth }
  const kind = instrumentKindOf(params)
  const enabled = params.on >= 0.5
  /**
   * Which badges this track offers. The drum kit is a drum-track choice
   * only — except on a track that somehow already holds it (an older
   * project, a peer's edit), where hiding the button would leave the
   * instrument unnameable and impossible to switch away from.
   */
  const offersKind = (candidate: InstrumentKind): boolean =>
    candidate !== 'drums' || track.kind === 'drum' || kind === 'drums'
  const setParam = (param: string, value: number): void => {
    projectStore.dispatch({ type: 'track/setSynthParam', trackId: track.id, param, value })
  }

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
        <span className="fx-section-title">{KIND_LABELS[kind]}</span>
        <div className="fx-waves">
          {INSTRUMENT_KINDS.map((k, index) =>
            offersKind(k) ? (
              <button
                key={k}
                className={`fx-wave fx-inst-kind ${kind === k ? 'fx-wave-active' : ''}`}
                title={KIND_LABELS[k]}
                onClick={() => setParam('instrument', index)}
              >
                {KIND_BADGES[k]}
              </button>
            ) : null
          )}
        </div>
        <button
          className="fx-remove"
          title="Remove the instrument from this track (its notes are kept)"
          onClick={() => setParam('present', 0)}
        >
          ×
        </button>
      </div>
      {kind === 'analog' && <AnalogBody params={params} setParam={setParam} />}
      {kind === 'sampler' && <SamplerBody track={track} params={params} setParam={setParam} />}
      {kind === 'drums' && <DrumBody track={track} params={params} setParam={setParam} />}
    </div>
  )
}

interface BodyProps {
  params: Record<string, number>
  setParam: (param: string, value: number) => void
}

function AnalogBody({ params, setParam }: BodyProps): React.JSX.Element {
  return (
    <>
      <div className="fx-waves fx-inst-row">
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
      {ANALOG_PARAMS.map((key) => (
        <ParamSlider
          key={key}
          def={SYNTH_DEFS[key]}
          value={params[key]}
          onCommit={(v) => setParam(key, v)}
        />
      ))}
    </>
  )
}

function SamplerBody({ track, params, setParam }: BodyProps & { track: Track }): React.JSX.Element {
  const assetId = track.samplerAssetId ?? null
  const asset = assetId ? assetStore.get(assetId) : undefined
  const slicesMode = Math.round(params.smpMode) === 1
  const sliceCount =
    assetId && asset?.seconds && slicesMode
      ? sliceRegions(assetOnsets(assetId), asset.seconds).length
      : 0

  const onDrop = (e: React.DragEvent): void => {
    const raw = e.dataTransfer.getData(BAY_DRAG_MIME)
    if (!raw) return
    e.preventDefault()
    const payload = JSON.parse(raw) as BayDragPayload
    if (payload.kind !== 'audio') return
    projectStore.dispatch({
      type: 'track/setSampler',
      trackId: track.id,
      assetId: payload.assetId
    })
  }

  return (
    <>
      <div
        className={`smp-drop ${asset ? 'smp-drop-loaded' : ''}`}
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes(`${BAY_DRAG_MIME}-audio`)) {
            e.preventDefault()
            e.dataTransfer.dropEffect = 'copy'
          }
        }}
        onDrop={onDrop}
      >
        {asset ? (
          <>
            <button
              className="smp-audition"
              title="Audition (plays through the track's effects)"
              onPointerDown={() => auditionDown(track.id, params.smpRoot, 1)}
              onPointerUp={() => auditionUp(track.id, params.smpRoot)}
              onPointerLeave={() => auditionUp(track.id, params.smpRoot)}
            >
              ▶
            </button>
            <span className="smp-name" title={asset.name}>
              {asset.name}
            </span>
            <span className="statusbar-dim">
              {asset.seconds !== null ? `${asset.seconds.toFixed(2)} s` : '…'}
              {slicesMode && sliceCount > 0 ? ` · ${sliceCount} slices` : ''}
            </span>
            <button
              className="fx-remove"
              title="Unload the sample"
              onClick={() =>
                projectStore.dispatch({ type: 'track/setSampler', trackId: track.id, assetId: null })
              }
            >
              ×
            </button>
          </>
        ) : (
          <span className="statusbar-dim">Drop a sample here from Files</span>
        )}
      </div>
      <div className="fx-waves fx-inst-row">
        <button
          className={`fx-wave fx-inst-kind ${slicesMode ? '' : 'fx-wave-active'}`}
          title="Chromatic: the sample pitched across the keyboard from the root note"
          onClick={() => setParam('smpMode', 0)}
        >
          KEYS
        </button>
        <button
          className={`fx-wave fx-inst-kind ${slicesMode ? 'fx-wave-active' : ''}`}
          title="Slices: each key plays one transient slice (C1 = slice 1)"
          onClick={() => setParam('smpMode', 1)}
        >
          SLICE
        </button>
        {!slicesMode && (
          <button
            className={`fx-wave fx-inst-kind ${params.smpLoop >= 0.5 ? 'fx-wave-active' : ''}`}
            title="Loop the start–end region while a key is held"
            onClick={() => setParam('smpLoop', params.smpLoop >= 0.5 ? 0 : 1)}
          >
            LOOP
          </button>
        )}
      </div>
      {!slicesMode && (
        <>
          <ParamSlider
            def={SYNTH_DEFS.smpRoot}
            value={params.smpRoot}
            onCommit={(v) => setParam('smpRoot', v)}
          />
          <ParamSlider
            def={SYNTH_DEFS.smpStart}
            value={params.smpStart}
            onCommit={(v) => setParam('smpStart', v)}
          />
          <ParamSlider
            def={SYNTH_DEFS.smpEnd}
            value={params.smpEnd}
            onCommit={(v) => setParam('smpEnd', v)}
          />
        </>
      )}
      {SAMPLER_ENVELOPE.map((key) => (
        <ParamSlider
          key={key}
          def={SYNTH_DEFS[key]}
          value={params[key]}
          onCommit={(v) => setParam(key, v)}
        />
      ))}
    </>
  )
}

function DrumBody({ track, params, setParam }: BodyProps & { track: Track }): React.JSX.Element {
  const [selected, setSelected] = useState(DRUM_PADS[0].key)
  const pad = DRUM_PADS.find((p) => p.key === selected) ?? DRUM_PADS[0]

  return (
    <>
      <div className="drum-pads">
        {DRUM_PADS.map((p) => (
          <button
            key={p.key}
            className={`drum-pad ${selected === p.key ? 'drum-pad-selected' : ''}`}
            title={`${p.label} — click to audition, edit its knobs below`}
            onPointerDown={() => {
              setSelected(p.key)
              auditionDown(track.id, p.pitch, 0.9)
            }}
            onPointerUp={() => auditionUp(track.id, p.pitch)}
            onPointerLeave={() => auditionUp(track.id, p.pitch)}
          >
            {p.label}
          </button>
        ))}
      </div>
      {(['Tune', 'Decay', 'Tone', 'Level'] as const).map((suffix) => {
        const key = `${pad.key}${suffix}`
        return (
          <ParamSlider
            key={key}
            def={SYNTH_DEFS[key]}
            value={params[key]}
            onCommit={(v) => setParam(key, v)}
          />
        )
      })}
    </>
  )
}
