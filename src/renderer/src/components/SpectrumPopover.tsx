import { useEffect, useRef, useState } from 'react'
import { audioEngine } from '@/state/audioInstance'
import { useDismiss } from '@/lib/dismiss'
import { freqToX } from '@/lib/biquad'
import { dbToY, decayPeakHold, xToBin, SPECTRUM_FLOOR_DB } from '@/lib/spectrum'
import { fitCanvas, theme } from './fx/PluginVisuals'

/**
 * Master-bus spectrum analyzer, one toggle deep in the transport bar's
 * metering cluster. Per-user ephemeral UI: open state lives here, nothing
 * touches the project document. The popover owns its rAF loop, so a
 * closed analyzer costs literally nothing — no analyser polling, no
 * paints — and the engine's tap node just sits idle.
 */

/** Vertical gridlines; only the decades carry labels. */
const GRID_FREQS: ReadonlyArray<readonly [number, string | null]> = [
  [50, null],
  [100, '100'],
  [200, null],
  [500, null],
  [1000, '1k'],
  [2000, null],
  [5000, null],
  [10000, '10k']
]

/** Faint horizontal dB lines between the 0 dB top and −90 dB floor. */
const GRID_DBS = [-30, -60]

export function SpectrumButton(): React.JSX.Element {
  const [open, setOpen] = useState(false)
  useDismiss(open, () => setOpen(false))
  return (
    <div className="collab-anchor">
      <button
        className={`tbtn ${open ? 'tbtn-active' : ''}`}
        title="Master spectrum analyzer"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={() => setOpen((v) => !v)}
      >
        ◭
      </button>
      {open && <SpectrumPopover />}
    </div>
  )
}

/**
 * The analyzer itself: filled live spectrum from getFloatFrequencyData on
 * a log 20 Hz–20 kHz axis, −90..0 dB, with a slow-decaying peak-hold
 * ghost — painted straight to the canvas in this component's own rAF
 * loop, never through React state. Colors come from CSS variables read at
 * paint time (like the waveform painters), so a theme change repaints
 * correctly on the next frame. When the engine cannot supply an analyser
 * (no backend yet, or the native path) a short note takes the canvas's
 * place; the loop keeps checking, so the feed appearing swaps it in live.
 */
function SpectrumPopover(): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [available, setAvailable] = useState(() => audioEngine.masterSpectrumAnalyser() !== null)
  const availableRef = useRef(available)

  useEffect(() => {
    let raf = 0
    let binBuf: Float32Array<ArrayBuffer> | null = null
    /** Per-pixel-column dB values (index 0..w) and their peak-hold trace. */
    let cols: Float32Array | null = null
    let peaks: Float32Array | null = null

    const draw = (): void => {
      raf = requestAnimationFrame(draw)
      const analyser = audioEngine.masterSpectrumAnalyser()
      const ok = analyser !== null
      if (ok !== availableRef.current) {
        availableRef.current = ok
        setAvailable(ok)
      }
      if (!analyser) return
      const canvas = canvasRef.current
      if (!canvas) return
      const ctx = fitCanvas(canvas)
      if (!ctx) return
      const w = canvas.clientWidth
      const h = canvas.clientHeight

      const bins = analyser.frequencyBinCount
      if (!binBuf || binBuf.length !== bins) binBuf = new Float32Array(bins)
      analyser.getFloatFrequencyData(binBuf)

      if (!cols || cols.length !== w + 1) {
        cols = new Float32Array(w + 1)
        peaks = new Float32Array(w + 1).fill(SPECTRUM_FLOOR_DB)
      }
      const sampleRate = analyser.context.sampleRate
      for (let x = 0; x <= w; x++) {
        const bin = xToBin(x, w, bins, sampleRate)
        const i = Math.floor(bin)
        const frac = bin - i
        // Clamp to the display floor BEFORE interpolating: silent bins
        // read -Infinity, and 0 × -Infinity is NaN.
        const a = Math.max(SPECTRUM_FLOOR_DB, binBuf[i])
        const b = Math.max(SPECTRUM_FLOOR_DB, binBuf[Math.min(bins - 1, i + 1)])
        cols[x] = a * (1 - frac) + b * frac
      }
      decayPeakHold(peaks!, cols)

      const colors = theme()
      ctx.clearRect(0, 0, w, h)

      // Grid: log-frequency decades and a couple of faint dB lines.
      ctx.lineWidth = 1
      ctx.strokeStyle = colors.grid
      ctx.fillStyle = colors.dim
      ctx.font = '8px ui-monospace, monospace'
      for (const [f, label] of GRID_FREQS) {
        const x = Math.round(freqToX(f, w)) + 0.5
        ctx.globalAlpha = label ? 0.55 : 0.28
        ctx.beginPath()
        ctx.moveTo(x, 0)
        ctx.lineTo(x, h)
        ctx.stroke()
        if (label) {
          ctx.globalAlpha = 0.8
          ctx.fillText(label, x + 3, h - 3)
        }
      }
      ctx.globalAlpha = 0.35
      for (const db of GRID_DBS) {
        const y = Math.round(dbToY(db, h)) + 0.5
        ctx.beginPath()
        ctx.moveTo(0, y)
        ctx.lineTo(w, y)
        ctx.stroke()
        ctx.globalAlpha = 0.7
        ctx.fillText(`${db}`, 3, y - 2)
        ctx.globalAlpha = 0.35
      }
      ctx.globalAlpha = 1

      // Peak-hold ghost behind the live fill — the slow-falling trace.
      ctx.beginPath()
      for (let x = 0; x <= w; x++) {
        const y = dbToY(peaks![x], h)
        if (x === 0) ctx.moveTo(x, y)
        else ctx.lineTo(x, y)
      }
      ctx.globalAlpha = 0.5
      ctx.strokeStyle = colors.dim
      ctx.stroke()
      ctx.globalAlpha = 1

      // The live spectrum: filled area with a brighter stroked edge.
      ctx.beginPath()
      ctx.moveTo(0, h)
      for (let x = 0; x <= w; x++) ctx.lineTo(x, dbToY(cols[x], h))
      ctx.lineTo(w, h)
      ctx.closePath()
      ctx.globalAlpha = 0.25
      ctx.fillStyle = colors.accent
      ctx.fill()
      ctx.globalAlpha = 0.9
      ctx.strokeStyle = colors.accent
      ctx.lineWidth = 1.4
      ctx.beginPath()
      for (let x = 0; x <= w; x++) {
        const y = dbToY(cols[x], h)
        if (x === 0) ctx.moveTo(x, y)
        else ctx.lineTo(x, y)
      }
      ctx.stroke()
      ctx.globalAlpha = 1
    }

    draw()
    return () => cancelAnimationFrame(raf)
  }, [])

  return (
    <div className="spectrum-popover" onPointerDown={(e) => e.stopPropagation()}>
      {available ? (
        <canvas ref={canvasRef} className="spectrum-canvas" />
      ) : (
        <div className="spectrum-empty">
          No spectrum feed — the analyzer lights up when the Web Audio engine is running.
        </div>
      )}
    </div>
  )
}
