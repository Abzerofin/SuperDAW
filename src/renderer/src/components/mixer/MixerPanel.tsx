import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { Track } from '@core/model/types'
import { MASTER_BUS_ID, MAX_GAIN } from '@core/model/types'
import { projectStore } from '@/state/projectStore'
import { useProjectState } from '@/state/hooks'
import { audioEngine } from '@/state/audioInstance'
import { panels } from '@/state/panels'
import { selection, useSelectedTrackId } from '@/state/selection'
import { capturePointer } from '@/lib/pointer'
import { parseDb, parsePan } from '@/lib/valueParse'
import { selectTrackRange } from '@/lib/trackActions'
import { EditableValue } from '../controls/EditableValue'
import { TrackMenu } from '../timeline/TrackMenu'
import { Knob } from './Knob'
import { StripMeter } from './StripMeter'

function panLabel(pan: number): string {
  if (Math.abs(pan) < 0.01) return 'C'
  return `${Math.round(Math.abs(pan) * 100)}${pan < 0 ? 'L' : 'R'}`
}

/**
 * The mixer: one strip per track plus master. Fader/pan drags preview
 * through the audio engine live and dispatch ONE op on release (same
 * gesture rule as clip drags). Double-click resets a control.
 */
export function MixerPanel(): React.JSX.Element {
  const state = useProjectState()
  const selectedTrackId = useSelectedTrackId()
  const rootRef = useRef<HTMLDivElement>(null)
  const tracks = state.trackOrder.map((id) => state.tracks[id]).filter((t) => t !== undefined)

  // The mixer follows the selection both ways: selecting a track anywhere
  // highlights its strip AND scrolls it into view on a wide project.
  useEffect(() => {
    if (!selectedTrackId) return
    rootRef.current
      ?.querySelector(`[data-ping-id="mixer:${selectedTrackId}"]`)
      ?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [selectedTrackId])

  return (
    <div className="mixer" ref={rootRef}>
      {tracks.length === 0 && <div className="bay-empty">No tracks yet</div>}
      {tracks.map((track) => (
        <TrackStrip key={track.id} track={track} />
      ))}
      <MasterStrip volume={state.masterVolume} />
    </div>
  )
}

function TrackStrip({ track }: { track: Track }): React.JSX.Element {
  const isSelected = useSyncExternalStore(selection.subscribe, () =>
    selection.isTrackSelected(track.id)
  )
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  return (
    <div
      className={`strip ${isSelected ? 'strip-selected' : ''}`}
      style={{ '--track-color': track.color } as React.CSSProperties}
      data-ping-id={`mixer:${track.id}`}
      data-ping={`mixer · "${track.name}"`}
      // Same selection gestures as a track header: plain click selects,
      // Ctrl/Cmd extends, Shift selects the range.
      onPointerDown={(e) => {
        if (e.ctrlKey || e.metaKey) selection.toggleTrack(track.id)
        else if (e.shiftKey) selectTrackRange(projectStore.state, track.id)
        else selection.selectTrack(track.id)
      }}
      onContextMenu={(e) => {
        e.preventDefault()
        e.stopPropagation()
        if (!selection.isTrackSelected(track.id)) selection.selectTrack(track.id)
        setMenu({ x: e.clientX, y: e.clientY })
      }}
    >
      <div className="strip-name" title={`${track.name} — right-click for all track actions`}>
        {track.name}
      </div>
      {menu && <TrackMenu track={track} x={menu.x} y={menu.y} onClose={() => setMenu(null)} />}
      <button
        className="corner-btn strip-fx"
        title="Effects (opens the Effects tab)"
        onClick={() => {
          selection.selectTrack(track.id)
          panels.openPanel('effects')
        }}
      >
        FX
      </button>
      <Knob
        value={track.pan}
        min={-1}
        max={1}
        defaultValue={0}
        format={panLabel}
        parse={parsePan}
        title="Pan · drag vertically (Shift = fine) · double-click for center · click the value to type it"
        onPreview={(pan) => audioEngine.previewTrackPan(track.id, pan)}
        onCommit={(pan) => projectStore.dispatch({ type: 'track/setPan', trackId: track.id, pan })}
      />
      <Fader
        gain={track.volume}
        meter={<StripMeter trackId={track.id} />}
        onPreview={(volume) => audioEngine.previewTrackVolume(track.id, volume)}
        onCommit={(volume) =>
          projectStore.dispatch({ type: 'track/setVolume', trackId: track.id, volume })
        }
      />
      <div className="strip-buttons">
        <button
          className={`track-toggle ${track.muted ? 'track-toggle-mute' : ''}`}
          onClick={() =>
            projectStore.dispatch({ type: 'track/setMute', trackId: track.id, muted: !track.muted })
          }
        >
          M
        </button>
        <button
          className={`track-toggle ${track.soloed ? 'track-toggle-solo' : ''}`}
          onClick={() =>
            projectStore.dispatch({ type: 'track/setSolo', trackId: track.id, soloed: !track.soloed })
          }
        >
          S
        </button>
      </div>
    </div>
  )
}

function MasterStrip({ volume }: { volume: number }): React.JSX.Element {
  const isSelected = useSyncExternalStore(selection.subscribe, () =>
    selection.isTrackSelected(MASTER_BUS_ID)
  )
  return (
    <div
      className={`strip strip-master ${isSelected ? 'strip-selected' : ''}`}
      style={{ '--track-color': 'var(--accent)' } as React.CSSProperties}
      // Selecting the master targets the Effects dock at its insert chain
      // (the shared mastering chain), exactly as selecting a track does.
      onPointerDown={() => selection.selectTrack(MASTER_BUS_ID)}
    >
      <div className="strip-name" title="Master bus — the whole mix. FX opens its insert chain.">
        Master
      </div>
      <button
        className="corner-btn strip-fx"
        title="Master effects (opens the Effects tab)"
        onClick={() => {
          selection.selectTrack(MASTER_BUS_ID)
          panels.openPanel('effects')
        }}
      >
        FX
      </button>
      <div className="strip-pan-spacer" />
      <Fader
        gain={volume}
        meter={<StripMeter trackId={null} />}
        onPreview={(v) => audioEngine.previewMasterVolume(v)}
        onCommit={(v) => projectStore.dispatch({ type: 'project/setMasterVolume', volume: v })}
      />
      <div className="strip-buttons" />
    </div>
  )
}

/* The fader stretches with the dock height, so drag sensitivity reads the
 * live element height (full throw = full range); this is only the fallback
 * for a zero-height measurement mid-layout. */
const FADER_H = 110

function Fader({
  gain,
  meter,
  onPreview,
  onCommit
}: {
  gain: number
  /** The strip's level meter, laid out console-style beside the fader. */
  meter?: React.ReactNode
  onPreview: (gain: number) => void
  onCommit: (gain: number) => void
}): React.JSX.Element {
  const [dragGain, setDragGain] = useState<number | null>(null)
  const lastY = useRef(0)
  const shown = dragGain ?? gain

  const begin = (e: React.PointerEvent): void => {
    if (e.button !== 0) return
    capturePointer(e)
    lastY.current = e.clientY
    setDragGain(gain)
  }
  const move = (e: React.PointerEvent): void => {
    if (dragGain === null) return
    // Incremental so Shift-fine can engage/release mid-drag.
    const dy = lastY.current - e.clientY
    lastY.current = e.clientY
    const scale = e.shiftKey ? 0.15 : 1
    const throwPx = e.currentTarget.clientHeight || FADER_H
    const next = clamp(dragGain + (dy / throwPx) * MAX_GAIN * scale)
    setDragGain(next)
    onPreview(next)
  }
  const end = (): void => {
    if (dragGain === null) return
    if (dragGain !== gain) onCommit(dragGain)
    setDragGain(null)
  }

  return (
    <div className="fader-wrap">
      <div className="fader-row">
        <div
          className="fader"
          onPointerDown={begin}
          onPointerMove={move}
          onPointerUp={end}
          onDoubleClick={() => onCommit(1)}
          title="Drag to set volume (Shift = fine) · double-click for 0 dB"
        >
          <div className="fader-fill" style={{ height: `${(shown / MAX_GAIN) * 100}%` }} />
          <div className="fader-thumb" style={{ bottom: `${(shown / MAX_GAIN) * 100}%` }} />
        </div>
        {meter}
      </div>
      <EditableValue
        className="fader-db"
        text={gainToDb(shown)}
        title="Volume in dB — click to type it"
        parse={parseDb}
        onCommit={onCommit}
      />
    </div>
  )
}

function clamp(gain: number): number {
  return Math.min(MAX_GAIN, Math.max(0, gain))
}

function gainToDb(gain: number): string {
  if (gain <= 0.0001) return '-∞'
  const db = 20 * Math.log10(gain)
  return `${db >= 0 ? '+' : ''}${db.toFixed(1)}`
}
