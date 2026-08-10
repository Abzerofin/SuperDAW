import { useEffect, useRef, useState } from 'react'
import type { Track } from '@core/model/types'
import { MAX_GAIN } from '@core/model/types'
import { projectStore } from '@/state/projectStore'
import { audioEngine } from '@/state/audioInstance'
import { capturePointer } from '@/lib/pointer'
import { parseDb, parsePan } from '@/lib/valueParse'
import { EditableValue } from '../controls/EditableValue'
import { Knob } from '../mixer/Knob'

/**
 * The mixer essentials that live on the track header itself: a stereo pan
 * knob and a volume slider whose track doubles as a live level meter.
 * Both follow the one-gesture-one-op rule — drags preview through the
 * engine and dispatch a single operation on release.
 */

function panLabel(pan: number): string {
  if (Math.abs(pan) < 0.01) return 'C'
  return `${Math.round(Math.abs(pan) * 100)}${pan < 0 ? 'L' : 'R'}`
}

function gainToDb(gain: number): string {
  if (gain <= 0.0001) return '-∞'
  const db = 20 * Math.log10(gain)
  return `${db >= 0 ? '+' : ''}${db.toFixed(1)}`
}

export function TrackStripControls({ track }: { track: Track }): React.JSX.Element {
  return (
    <div className="track-strip">
      <Knob
        value={track.pan}
        min={-1}
        max={1}
        defaultValue={0}
        size={26}
        format={panLabel}
        parse={parsePan}
        title="Pan · drag vertically (Shift = fine) · double-click for centre · click the value to type it"
        onPreview={(pan) => audioEngine.previewTrackPan(track.id, pan)}
        onCommit={(pan) => projectStore.dispatch({ type: 'track/setPan', trackId: track.id, pan })}
      />
      <VolumeSlider track={track} />
    </div>
  )
}

function VolumeSlider({ track }: { track: Track }): React.JSX.Element {
  const [dragGain, setDragGain] = useState<number | null>(null)
  const barRef = useRef<HTMLDivElement>(null)
  const meterRef = useRef<HTMLDivElement>(null)
  const peakRef = useRef<HTMLDivElement>(null)
  const shown = dragGain ?? track.volume

  // Live level, painted straight onto the DOM from a rAF loop so metering
  // never re-renders React (one repaint per frame, whatever the track count).
  useEffect(() => {
    let raf = 0
    let level = 0
    let flashUntil = 0
    let peak = 0
    let peakUntil = 0
    const draw = (): void => {
      const now = performance.now()
      const raw = audioEngine.trackLevel(track.id)
      // Decay toward zero, but snap to it: an asymptote would otherwise keep
      // writing denormal widths into the DOM forever on a silent track.
      level = Math.max(raw, level * 0.9)
      if (level < 0.001) level = 0
      if (meterRef.current) {
        meterRef.current.style.width = `${Math.min(100, level * 100)}%`
      }
      // Peak-hold remnant: a marker stays where the level last peaked, then
      // vanishes after a second of nothing louder arriving.
      if (raw >= peak && raw > 0.001) {
        peak = raw
        peakUntil = now + 1000
      } else if (now >= peakUntil) {
        peak = 0
      }
      if (peakRef.current) {
        peakRef.current.style.left = `${Math.min(100, peak * 100)}%`
        peakRef.current.style.opacity = peak > 0 ? '1' : '0'
      }
      // Peaking (the analyser clamps at 1.0): flash the whole header red,
      // held briefly so a single-sample spike is still visible.
      if (raw >= 0.999) flashUntil = now + 350
      const header = meterRef.current?.closest('.track-header')
      header?.classList.toggle('track-peak-flash', now < flashUntil)
      raf = requestAnimationFrame(draw)
    }
    draw()
    return () => {
      cancelAnimationFrame(raf)
      meterRef.current?.closest('.track-header')?.classList.remove('track-peak-flash')
    }
  }, [track.id])

  const lastX = useRef(0)

  const gainAt = (clientX: number): number => {
    const rect = barRef.current?.getBoundingClientRect()
    if (!rect) return track.volume
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width))
    return ratio * MAX_GAIN
  }

  const begin = (e: React.PointerEvent): void => {
    if (e.button !== 0) return
    e.stopPropagation() // don't start a track-reorder drag
    capturePointer(e)
    lastX.current = e.clientX
    // Shift means "adjust from where it is": no jump to the click point.
    const next = e.shiftKey ? track.volume : gainAt(e.clientX)
    setDragGain(next)
    audioEngine.previewTrackVolume(track.id, next)
  }
  const move = (e: React.PointerEvent): void => {
    if (dragGain === null) return
    // Incremental so Shift-fine can engage/release mid-drag.
    const dx = e.clientX - lastX.current
    lastX.current = e.clientX
    const width = barRef.current?.getBoundingClientRect().width ?? 1
    const scale = e.shiftKey ? 0.15 : 1
    const next = Math.min(
      MAX_GAIN,
      Math.max(0, dragGain + (dx / width) * MAX_GAIN * scale)
    )
    setDragGain(next)
    audioEngine.previewTrackVolume(track.id, next)
  }
  const end = (): void => {
    if (dragGain === null) return
    if (dragGain !== track.volume) {
      projectStore.dispatch({ type: 'track/setVolume', trackId: track.id, volume: dragGain })
    }
    setDragGain(null)
  }

  return (
    <div className="track-vol">
      <div
        className="track-vol-bar"
        ref={barRef}
        title="Volume · drag (Shift = fine) · double-click for 0 dB"
        onPointerDown={begin}
        onPointerMove={move}
        onPointerUp={end}
        onDoubleClick={(e) => {
          e.stopPropagation()
          projectStore.dispatch({ type: 'track/setVolume', trackId: track.id, volume: 1 })
        }}
      >
        <div className="track-vol-meter" ref={meterRef} />
        <div className="track-vol-peakmark" ref={peakRef} />
        <div className="track-vol-fill" style={{ width: `${(shown / MAX_GAIN) * 100}%` }} />
        <div className="track-vol-thumb" style={{ left: `${(shown / MAX_GAIN) * 100}%` }} />
      </div>
      <EditableValue
        className="track-vol-db"
        text={gainToDb(shown)}
        title="Volume in dB — click to type it"
        parse={parseDb}
        onCommit={(volume) =>
          projectStore.dispatch({ type: 'track/setVolume', trackId: track.id, volume })
        }
      />
    </div>
  )
}
