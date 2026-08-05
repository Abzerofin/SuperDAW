import { useRef, useState } from 'react'
import type { Track } from '@core/model/types'
import { MAX_GAIN } from '@core/model/types'
import { projectStore } from '@/state/projectStore'
import { useProjectState } from '@/state/hooks'
import { audioEngine } from '@/state/audioInstance'
import { fxUi } from '@/state/fxUi'
import { capturePointer } from '@/lib/pointer'

/**
 * The mixer: one strip per track plus master. Fader/pan drags preview
 * through the audio engine live and dispatch ONE op on release (same
 * gesture rule as clip drags). Double-click resets a control.
 */
export function MixerPanel(): React.JSX.Element {
  const state = useProjectState()
  const tracks = state.trackOrder.map((id) => state.tracks[id]).filter((t) => t !== undefined)

  return (
    <div className="mixer">
      {tracks.length === 0 && <div className="bay-empty">No tracks yet</div>}
      {tracks.map((track) => (
        <TrackStrip key={track.id} track={track} />
      ))}
      <MasterStrip volume={state.masterVolume} />
    </div>
  )
}

function TrackStrip({ track }: { track: Track }): React.JSX.Element {
  return (
    <div className="strip" style={{ '--track-color': track.color } as React.CSSProperties}>
      <div className="strip-name" title={track.name}>
        {track.name}
      </div>
      <button className="corner-btn strip-fx" onClick={() => fxUi.toggle(track.id)}>
        FX
      </button>
      <PanKnob
        pan={track.pan}
        onPreview={(pan) => audioEngine.previewTrackPan(track.id, pan)}
        onCommit={(pan) => projectStore.dispatch({ type: 'track/setPan', trackId: track.id, pan })}
      />
      <Fader
        gain={track.volume}
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
  return (
    <div className="strip strip-master" style={{ '--track-color': 'var(--accent)' } as React.CSSProperties}>
      <div className="strip-name">Master</div>
      <div className="strip-pan-spacer" />
      <Fader
        gain={volume}
        onPreview={(v) => audioEngine.previewMasterVolume(v)}
        onCommit={(v) => projectStore.dispatch({ type: 'project/setMasterVolume', volume: v })}
      />
      <div className="strip-buttons" />
    </div>
  )
}

const FADER_H = 110

function Fader({
  gain,
  onPreview,
  onCommit
}: {
  gain: number
  onPreview: (gain: number) => void
  onCommit: (gain: number) => void
}): React.JSX.Element {
  const [dragGain, setDragGain] = useState<number | null>(null)
  const origin = useRef({ y: 0, gain: 0 })
  const shown = dragGain ?? gain

  const begin = (e: React.PointerEvent): void => {
    if (e.button !== 0) return
    capturePointer(e)
    origin.current = { y: e.clientY, gain }
    setDragGain(gain)
  }
  const move = (e: React.PointerEvent): void => {
    if (dragGain === null) return
    const next = clamp(origin.current.gain + ((origin.current.y - e.clientY) / FADER_H) * MAX_GAIN)
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
      <div
        className="fader"
        onPointerDown={begin}
        onPointerMove={move}
        onPointerUp={end}
        onDoubleClick={() => onCommit(1)}
        title="Drag to set volume · double-click for 0 dB"
      >
        <div className="fader-fill" style={{ height: `${(shown / MAX_GAIN) * 100}%` }} />
        <div className="fader-thumb" style={{ bottom: `${(shown / MAX_GAIN) * 100}%` }} />
      </div>
      <div className="fader-db mono">{gainToDb(shown)}</div>
    </div>
  )
}

function PanKnob({
  pan,
  onPreview,
  onCommit
}: {
  pan: number
  onPreview: (pan: number) => void
  onCommit: (pan: number) => void
}): React.JSX.Element {
  const [dragPan, setDragPan] = useState<number | null>(null)
  const origin = useRef({ x: 0, pan: 0 })
  const shown = dragPan ?? pan

  const begin = (e: React.PointerEvent): void => {
    if (e.button !== 0) return
    capturePointer(e)
    origin.current = { x: e.clientX, pan }
    setDragPan(pan)
  }
  const move = (e: React.PointerEvent): void => {
    if (dragPan === null) return
    const next = Math.min(1, Math.max(-1, origin.current.pan + (e.clientX - origin.current.x) / 40))
    setDragPan(next)
    onPreview(next)
  }
  const end = (): void => {
    if (dragPan === null) return
    if (dragPan !== pan) onCommit(dragPan)
    setDragPan(null)
  }

  return (
    <div
      className="pan"
      onPointerDown={begin}
      onPointerMove={move}
      onPointerUp={end}
      onDoubleClick={() => onCommit(0)}
      title="Drag to pan · double-click for center"
    >
      <div className="pan-track">
        <div className="pan-thumb" style={{ left: `${((shown + 1) / 2) * 100}%` }} />
      </div>
      <div className="pan-label mono">
        {Math.abs(shown) < 0.01 ? 'C' : `${Math.round(Math.abs(shown) * 100)}${shown < 0 ? 'L' : 'R'}`}
      </div>
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
