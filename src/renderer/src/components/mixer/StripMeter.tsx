import { useEffect, useRef } from 'react'
import type { TrackId } from '@core/model/types'
import type { MeterReading } from '@audio/engine'
import { audioEngine } from '@/state/audioInstance'
import { meterBus } from '@/lib/meterBus'

/**
 * The mixer strip's channel meter: a vertical dB-scaled bar beside the
 * fader (peak, with a brighter RMS core), a 1 s peak-hold tick, and a
 * clip light that latches when the signal goes over 0 dBFS.
 *
 * Levels are painted straight onto the DOM through the shared meter bus —
 * one rAF loop app-wide, asleep whenever nothing is audible — so metering
 * never re-renders React and costs nothing while the mixer tab is closed
 * (the panel unmounts, which unregisters every meter). Strips scrolled
 * out of the mixer's viewport keep their peak/clip bookkeeping (a scan of
 * a 256-sample window) but skip all style writes.
 *
 * The bar is a "shutter" over a fixed full-height green→amber→red
 * gradient: one height write reveals exactly the console-style zone
 * colours for the current level, instead of recolouring the bar in JS.
 */

const HOLD_MS = 1000
/** Meter floor: −60 dBFS maps to the bottom of the bar, 0 dBFS to the top. */
const FLOOR_DB = -60

/** Amplitude (0..1+) → bar percentage on the dB scale. */
function barPct(v: number): number {
  if (v <= 0.001) return 0
  const db = 20 * Math.log10(v)
  if (db <= FLOOR_DB) return 0
  return Math.min(100, ((db - FLOOR_DB) / -FLOOR_DB) * 100)
}

/** Faint console-style scale marks. */
const SCALE_DBS = [-6, -12, -24, -36, -48]

/**
 * Every mounted meter's clip-clear, so the master strip's clip light can
 * clear the whole desk in one click (the classic console "clear clips").
 */
const clipClears = new Set<() => void>()

export function StripMeter({ trackId }: { trackId: TrackId | null }): React.JSX.Element {
  const wellRef = useRef<HTMLDivElement>(null)
  const shutterRef = useRef<HTMLDivElement>(null)
  const rmsRef = useRef<HTMLDivElement>(null)
  const holdRef = useRef<HTMLDivElement>(null)
  const clipRef = useRef<HTMLButtonElement>(null)
  const clearClipRef = useRef<() => void>(() => {})

  useEffect(() => {
    // Caller-owned reading: the engine fills it in place, so a meter poll
    // allocates nothing, ever.
    const reading: MeterReading = { peak: 0, rms: 0 }
    let level = 0
    let rms = 0
    let hold = 0
    let holdUntil = 0
    let clipped = false
    let visible = true

    const clip = clipRef.current
    const setClip = (on: boolean): void => {
      clipped = on
      clip?.classList.toggle('strip-clip-on', on)
    }
    const clearClip = (): void => setClip(false)
    clearClipRef.current = clearClip
    clipClears.add(clearClip)

    // Strips scrolled out of the mixer's horizontal viewport skip their
    // style writes (the observer is DOM-native; guarded for the DOM-less
    // test runner). State keeps ticking so the clip latch stays honest.
    let io: IntersectionObserver | null = null
    if (typeof IntersectionObserver !== 'undefined' && wellRef.current) {
      io = new IntersectionObserver((entries) => {
        visible = entries[0]?.isIntersecting ?? true
        // Repaint what happened off-screen as soon as we scroll back.
        if (visible) meterBus.wake()
      })
      io.observe(wellRef.current)
    }

    const draw = (now: number): boolean => {
      if (trackId === null) audioEngine.masterMeter(reading)
      else audioEngine.trackMeter(trackId, reading)
      // Decay toward zero but snap to it (same constants as the track
      // headers, so both surfaces fall at the same rate).
      level = Math.max(reading.peak, level * 0.9)
      if (level < 0.001) level = 0
      rms = Math.max(reading.rms, rms * 0.9)
      if (rms < 0.001) rms = 0
      // Peak-hold: the tick sits at the loudest recent peak for a second.
      if (reading.peak >= hold && reading.peak > 0.001) {
        hold = reading.peak
        holdUntil = now + HOLD_MS
      } else if (now >= holdUntil) {
        hold = 0
      }
      // Over 0 dBFS (the reading's peak is unclamped): latch until clicked.
      if (reading.peak > 1 && !clipped) setClip(true)
      if (visible) {
        if (shutterRef.current) shutterRef.current.style.height = `${100 - barPct(level)}%`
        if (rmsRef.current) rmsRef.current.style.height = `${barPct(rms)}%`
        if (holdRef.current) {
          holdRef.current.style.bottom = `${Math.min(98, barPct(hold))}%`
          holdRef.current.style.opacity = hold > 0 ? '1' : '0'
        }
      }
      return level > 0 || rms > 0 || hold > 0
    }
    const unregister = meterBus.register(draw)
    return () => {
      unregister()
      clipClears.delete(clearClip)
      io?.disconnect()
    }
  }, [trackId])

  return (
    <div className="strip-meter">
      <button
        ref={clipRef}
        className="strip-clip"
        title={
          trackId === null
            ? 'Clip light — latches when the mix goes over 0 dBFS · click to clear every clip light'
            : 'Clip light — latches when this track goes over 0 dBFS · click to clear'
        }
        onClick={(e) => {
          e.stopPropagation()
          if (trackId === null) for (const clear of clipClears) clear()
          else clearClipRef.current()
        }}
      />
      <div className="strip-meter-well" ref={wellRef} title="Level · −60 to 0 dBFS">
        <div className="strip-meter-grad" />
        <div className="strip-meter-rms" ref={rmsRef} />
        <div className="strip-meter-shutter" ref={shutterRef} />
        {SCALE_DBS.map((db) => (
          <div
            key={db}
            className="strip-meter-tick"
            style={{ bottom: `${((db - FLOOR_DB) / -FLOOR_DB) * 100}%` }}
          />
        ))}
        <div className="strip-meter-hold" ref={holdRef} />
      </div>
    </div>
  )
}
