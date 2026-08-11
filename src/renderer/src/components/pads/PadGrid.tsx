import { useState } from 'react'
import type { PerformancePad, ProjectState, Track } from '@core/model/types'
import {
  PAD_GRID_COLS,
  PAD_GRID_ROWS,
  padIdAt
} from '@core/model/types'
import { useProjectState } from '@/state/hooks'
import { projectStore } from '@/state/projectStore'
import { audioEngine, assetStore } from '@/state/audioInstance'
import { padPerform, usePadPerform } from '@/state/padPerform'
import { useCollab } from '@/state/collab'
import { BAY_DRAG_MIME, type BayDragPayload } from '@/lib/importAudio'

/**
 * The Pads tab: an 8×8 launchpad. ASSIGNMENTS are document state (shared,
 * undoable, synced — the whole point for collaborative DJing); TRIGGERING
 * is performance, broadcast over presence so the room hears it. Trigger
 * with the mouse, the computer keyboard (bottom four rows), or a MIDI
 * grid controller.
 */

const PAD_COLORS = ['#e06c75', '#e0b25b', '#6fbf73', '#56b6c2', '#5b8def', '#a86fe0', '#e0709b', '#9aa0ae']

function emptyPad(row: number, col: number): PerformancePad {
  return {
    id: padIdAt(row, col),
    row,
    col,
    kind: 'sample',
    assetId: null,
    trackId: null,
    pitch: 60,
    clipId: null,
    name: '',
    color: null,
    gate: false
  }
}

export function PadGrid(): React.JSX.Element {
  const state = useProjectState()
  const perform = usePadPerform()
  useCollab() // roster changes etc. keep the hint fresh
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const selected = selectedId ? (state.pads[selectedId] ?? null) : null

  return (
    <div className="pads-panel">
      <div className="pads-side">
        <div className="pads-toolbar">
          <button
            className={`bay-btn ${perform.kbdEnabled ? 'fx-view-active' : ''}`}
            title="Trigger pads with the computer keyboard (rows 1–8 / QWERTY / ASDF / ZXCV)"
            onClick={() => padPerform.setKbdEnabled(!perform.kbdEnabled)}
          >
            KBD
          </button>
          <button
            className={`bay-btn ${perform.midiEnabled ? 'fx-view-active' : ''}`}
            title="Trigger pads from a MIDI grid controller (notes 36+, bottom-left upward)"
            onClick={() => padPerform.setMidiEnabled(!perform.midiEnabled)}
          >
            MIDI
          </button>
        </div>
        {selected ? (
          <PadEditor pad={selected} state={state} onClear={() => setSelectedId(null)} />
        ) : (
          <div className="pads-hint statusbar-dim">
            Drop samples from Files onto pads. Right-click a pad to edit it.
            <br />
            Sample pads fire one-shots · note pads play a track's instrument ·
            clip pads loop a clip from the next bar.
          </div>
        )}
      </div>
      <div className="pads-grid" data-ping-id="pads" data-ping="the pad grid">
        {Array.from({ length: PAD_GRID_ROWS * PAD_GRID_COLS }, (_, i) => {
          const row = Math.floor(i / PAD_GRID_COLS)
          const col = i % PAD_GRID_COLS
          const id = padIdAt(row, col)
          const pad = state.pads[id]
          return (
            <PadCell
              key={id}
              id={id}
              row={row}
              col={col}
              pad={pad}
              state={state}
              selected={selectedId === id}
              onSelect={() => setSelectedId(id)}
            />
          )
        })}
      </div>
    </div>
  )
}

function padLabel(pad: PerformancePad, state: ProjectState): string {
  if (pad.name !== '') return pad.name
  switch (pad.kind) {
    case 'sample':
      return pad.assetId ? (assetStore.get(pad.assetId)?.name ?? 'sample') : ''
    case 'note': {
      const track = pad.trackId ? state.tracks[pad.trackId] : undefined
      return track ? track.name : ''
    }
    case 'clip':
      return pad.clipId ? (state.clips[pad.clipId]?.name ?? '') : ''
  }
}

function padTint(pad: PerformancePad, state: ProjectState): string | null {
  if (pad.color) return pad.color
  if (pad.kind === 'clip' && pad.clipId) {
    const clip = state.clips[pad.clipId]
    if (clip) return clip.color ?? state.tracks[clip.trackId]?.color ?? null
  }
  if (pad.kind === 'note' && pad.trackId) return state.tracks[pad.trackId]?.color ?? null
  return PAD_COLORS[(pad.row + pad.col) % PAD_COLORS.length]
}

function PadCell({
  id,
  row,
  col,
  pad,
  state,
  selected,
  onSelect
}: {
  id: string
  row: number
  col: number
  pad: PerformancePad | undefined
  state: ProjectState
  selected: boolean
  onSelect: () => void
}): React.JSX.Element {
  const perform = usePadPerform()
  const lit =
    pad !== undefined &&
    (perform.isHeld(id) ||
      audioEngine.padSampleActive(id) ||
      (pad.kind === 'clip' && pad.clipId !== null && audioEngine.clipLoopActive(pad.clipId)))
  const tint = pad ? padTint(pad, state) : null

  return (
    <button
      className={`pad-cell ${pad ? 'pad-cell-assigned' : ''} ${lit ? 'pad-cell-lit' : ''} ${
        selected ? 'pad-cell-selected' : ''
      }`}
      style={tint ? ({ ['--pad-tint' as string]: tint } as React.CSSProperties) : undefined}
      title={
        pad
          ? `${padLabel(pad, state)} (${pad.kind}) — right-click to edit`
          : 'Empty pad — drop a sample from Files, or right-click to assign'
      }
      onPointerDown={(e) => {
        if (e.button !== 0) return
        if (pad) padPerform.padDown(id)
      }}
      onPointerUp={() => pad && padPerform.padUp(id)}
      onPointerLeave={() => pad && perform.isHeld(id) && padPerform.padUp(id)}
      onContextMenu={(e) => {
        e.preventDefault()
        onSelect()
      }}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes(`${BAY_DRAG_MIME}-audio`)) {
          e.preventDefault()
          e.dataTransfer.dropEffect = 'copy'
        }
      }}
      onDrop={(e) => {
        const raw = e.dataTransfer.getData(BAY_DRAG_MIME)
        if (!raw) return
        e.preventDefault()
        const payload = JSON.parse(raw) as BayDragPayload
        if (payload.kind !== 'audio') return
        projectStore.dispatch({
          type: 'pad/set',
          pad: {
            ...(pad ?? emptyPad(row, col)),
            kind: 'sample',
            assetId: payload.assetId,
            trackId: null,
            clipId: null
          }
        })
        onSelect()
      }}
    >
      <span className="pad-cell-label">{pad ? padLabel(pad, state) : ''}</span>
      {pad?.kind === 'clip' && <span className="pad-cell-kind">↻</span>}
      {pad?.kind === 'note' && <span className="pad-cell-kind">♪</span>}
    </button>
  )
}

function PadEditor({
  pad,
  state,
  onClear
}: {
  pad: PerformancePad
  state: ProjectState
  onClear: () => void
}): React.JSX.Element {
  const set = (changes: Partial<PerformancePad>): void => {
    projectStore.dispatch({ type: 'pad/set', pad: { ...pad, ...changes } })
  }
  const midiTracks = state.trackOrder
    .map((id) => state.tracks[id])
    .filter((t): t is Track => t !== undefined && t.kind === 'midi')
  const clips = Object.values(state.clips).sort((a, b) => a.start - b.start)

  return (
    <div className="pads-editor">
      <div className="pads-editor-head">
        <span className="fx-section-title">
          Pad {pad.row + 1}·{pad.col + 1}
        </span>
        <button
          className="fx-remove"
          title="Clear this pad"
          onClick={() => {
            projectStore.dispatch({ type: 'pad/clear', padId: pad.id })
            onClear()
          }}
        >
          ×
        </button>
      </div>
      <div className="fx-waves fx-inst-row">
        {(['sample', 'note', 'clip'] as const).map((kind) => (
          <button
            key={kind}
            className={`fx-wave fx-inst-kind ${pad.kind === kind ? 'fx-wave-active' : ''}`}
            onClick={() => set({ kind })}
          >
            {kind.toUpperCase()}
          </button>
        ))}
      </div>
      {pad.kind === 'sample' && (
        <div className="pads-field statusbar-dim">
          {pad.assetId
            ? (assetStore.get(pad.assetId)?.name ?? 'sample (transferring…)')
            : 'Drop a sample from Files onto the pad'}
        </div>
      )}
      {pad.kind === 'note' && (
        <>
          <select
            className="pads-select"
            value={pad.trackId ?? ''}
            onChange={(e) => set({ trackId: e.target.value || null })}
          >
            <option value="">— instrument track —</option>
            {midiTracks.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
          <div className="pads-field">
            <span className="statusbar-dim">Note</span>
            <input
              key={pad.pitch}
              className="pads-num"
              type="number"
              min={0}
              max={127}
              defaultValue={pad.pitch}
              onBlur={(e) => {
                const pitch = Number(e.target.value)
                if (Number.isFinite(pitch) && pitch !== pad.pitch) set({ pitch })
              }}
            />
          </div>
        </>
      )}
      {pad.kind === 'clip' && (
        <select
          className="pads-select"
          value={pad.clipId ?? ''}
          onChange={(e) => set({ clipId: e.target.value || null })}
        >
          <option value="">— clip to loop —</option>
          {clips.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name} · {state.tracks[c.trackId]?.name ?? '?'}
            </option>
          ))}
        </select>
      )}
      {pad.kind !== 'clip' && (
        <label className="pads-field">
          <input
            type="checkbox"
            checked={pad.gate}
            onChange={(e) => set({ gate: e.target.checked })}
          />
          <span className="statusbar-dim">Gate (stop on release)</span>
        </label>
      )}
      <input
        key={pad.id}
        className="pads-name"
        placeholder="Label"
        defaultValue={pad.name}
        onBlur={(e) => {
          if (e.target.value !== pad.name) set({ name: e.target.value })
        }}
      />
      <div className="pads-swatches">
        {PAD_COLORS.map((color) => (
          <button
            key={color}
            className={`pads-swatch ${pad.color === color ? 'pads-swatch-active' : ''}`}
            style={{ background: color }}
            onClick={() => set({ color: pad.color === color ? null : color })}
          />
        ))}
      </div>
    </div>
  )
}
