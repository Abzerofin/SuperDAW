import { useEffect, useRef, useState } from 'react'
import { EFFECT_DEFS, PARAEQ_BANDS, clampParam } from '@core/model/effects'
import type { PluginInstanceId } from '@core/model/types'
import { projectStore } from '@/state/projectStore'
import { audioEngine } from '@/state/audioInstance'
import { capturePointer } from '@/lib/pointer'
import { freqToX, magnitudeDb, paraeqBand, xToFreq, type Biquad } from '@/lib/biquad'
import { ParamSlider } from './ParamSlider'
import { drawSpectrum, fitCanvas, newPaintGate, shouldPaint, theme, useParamsRef } from './PluginVisuals'

/**
 * The parametric EQ editor: bands are points ON the response curve.
 * Drag a point to move its frequency and gain (one plugin/setParams op on
 * release), double-click empty space to place a band, double-click a
 * point to remove it, scroll over the canvas to shape the selected
 * band's Q. Fine controls for the selected band live below the canvas.
 */

type Params = Readonly<Record<string, number>>

const RANGE_DB = 20 // vertical span: ±20 dB (gains clamp at ±18)
const HIT_RADIUS = 9
const TYPE_LABELS = ['Peak', 'LoShf', 'HiShf', 'HP', 'LP', 'Notch']
/** Band types whose gain param is meaningless (their point rides the 0 dB line). */
const GAINLESS = new Set([3, 4, 5])
const BAND_COLORS = [
  '#5b8def',
  '#6fbf73',
  '#e0b25b',
  '#e06c75',
  '#9d7be0',
  '#4fc1c9',
  '#d47fb8',
  '#98a86c'
]

interface Band {
  n: number
  on: boolean
  type: number
  freq: number
  gain: number
  q: number
}

function bandsOf(p: Params): Band[] {
  const bands: Band[] = []
  for (let n = 1; n <= PARAEQ_BANDS; n++) {
    bands.push({
      n,
      on: (p[`b${n}on`] ?? 0) >= 0.5,
      type: Math.round(p[`b${n}type`] ?? 0),
      freq: p[`b${n}freq`] ?? 1000,
      gain: p[`b${n}gain`] ?? 0,
      q: p[`b${n}q`] ?? 1
    })
  }
  return bands
}

const gainToY = (gain: number, h: number): number => h / 2 - (gain / RANGE_DB) * (h / 2)
const yToGain = (y: number, h: number): number => ((h / 2 - y) / (h / 2)) * RANGE_DB

const responseOf = (band: Band): Biquad => paraeqBand(band.type, band.freq, band.q, band.gain)

export function ParametricEq({
  instanceId,
  params
}: {
  instanceId: PluginInstanceId
  params: Params
}): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  // In-flight gesture values (drag, wheel), merged over committed params.
  const [preview, setPreview] = useState<Record<string, number>>({})
  const [selected, setSelected] = useState<number | null>(null)
  const effective: Params = { ...params, ...preview }
  const effectiveRef = useParamsRef(effective)
  const selectedRef = useRef(selected)
  selectedRef.current = selected
  /** The drag in progress: band + the values it has previewed so far. */
  const dragRef = useRef<{ n: number; values: Record<string, number> } | null>(null)
  /** Wheel gesture: commit is debounced so one scroll burst = one op. */
  const wheelRef = useRef<{ timer: ReturnType<typeof setTimeout> | null; values: Record<string, number> }>({
    timer: null,
    values: {}
  })

  const defs = EFFECT_DEFS.paraeq.params

  const previewValues = (values: Record<string, number>): void => {
    audioEngine.previewPluginParams(instanceId, values)
    setPreview((p) => ({ ...p, ...values }))
  }

  const commitValues = (values: Record<string, number>): void => {
    // Drop keys that already hold the committed value: a click without a
    // drag must not spend an undo step.
    const changed = Object.fromEntries(
      Object.entries(values).filter(([key, v]) => params[key] !== v)
    )
    if (Object.keys(changed).length > 0) {
      projectStore.dispatch({ type: 'plugin/setParams', instanceId, params: changed })
    }
    setPreview({})
  }

  // ---------- Canvas interactions ----------

  const canvasPos = (e: { clientX: number; clientY: number }): { x: number; y: number } => {
    const rect = canvasRef.current!.getBoundingClientRect()
    return { x: e.clientX - rect.left, y: e.clientY - rect.top }
  }

  const hitBand = (x: number, y: number): Band | null => {
    const canvas = canvasRef.current
    if (!canvas) return null
    const w = canvas.clientWidth
    const h = canvas.clientHeight
    let best: Band | null = null
    let bestDist = HIT_RADIUS
    for (const band of bandsOf(effectiveRef.current)) {
      if (!band.on) continue
      const bx = freqToX(band.freq, w)
      const by = GAINLESS.has(band.type) ? h / 2 : gainToY(band.gain, h)
      const dist = Math.hypot(x - bx, y - by)
      if (dist <= bestDist) {
        best = band
        bestDist = dist
      }
    }
    return best
  }

  const onPointerDown = (e: React.PointerEvent): void => {
    if (e.button !== 0) return
    const { x, y } = canvasPos(e)
    const band = hitBand(x, y)
    if (!band) return
    capturePointer(e)
    setSelected(band.n)
    dragRef.current = { n: band.n, values: {} }
  }

  const onPointerMove = (e: React.PointerEvent): void => {
    const drag = dragRef.current
    const canvas = canvasRef.current
    if (!drag || !canvas) return
    const { x, y } = canvasPos(e)
    const w = canvas.clientWidth
    const h = canvas.clientHeight
    const band = bandsOf(effectiveRef.current)[drag.n - 1]
    const values: Record<string, number> = {
      [`b${drag.n}freq`]: clampParam(
        defs[`b${drag.n}freq`],
        xToFreq(Math.min(w, Math.max(0, x)), w)
      )
    }
    if (!GAINLESS.has(band.type)) {
      values[`b${drag.n}gain`] = clampParam(defs[`b${drag.n}gain`], yToGain(y, h))
    }
    drag.values = values
    previewValues(values)
  }

  const onPointerUp = (): void => {
    const drag = dragRef.current
    if (!drag) return
    dragRef.current = null
    commitValues(drag.values)
  }

  const onDoubleClick = (e: React.MouseEvent): void => {
    const canvas = canvasRef.current
    if (!canvas) return
    const { x, y } = canvasPos(e)
    const band = hitBand(x, y)
    if (band) {
      // Remove: the slot goes dormant (transparent) and keeps its settings.
      commitValues({ [`b${band.n}on`]: 0 })
      if (selected === band.n) setSelected(null)
      return
    }
    const free = bandsOf(effectiveRef.current).find((b) => !b.on)
    if (!free) return
    const w = canvas.clientWidth
    const h = canvas.clientHeight
    commitValues({
      [`b${free.n}on`]: 1,
      [`b${free.n}type`]: 0,
      [`b${free.n}freq`]: clampParam(defs[`b${free.n}freq`], xToFreq(x, w)),
      [`b${free.n}gain`]: clampParam(defs[`b${free.n}gain`], yToGain(y, h)),
      [`b${free.n}q`]: 1
    })
    setSelected(free.n)
  }

  // Wheel shapes the selected band's Q. Native listener: React's onWheel
  // is passive, and the dock must not scroll while shaping a band.
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const onWheel = (e: WheelEvent): void => {
      const n = selectedRef.current
      if (n === null) return
      e.preventDefault()
      const key = `b${n}q`
      const current = wheelRef.current.values[key] ?? effectiveRef.current[key] ?? 1
      const q = clampParam(defs[key], current * Math.pow(1.12, e.deltaY > 0 ? -1 : 1))
      wheelRef.current.values = { [key]: q }
      audioEngine.previewPluginParams(instanceId, { [key]: q })
      setPreview((p) => ({ ...p, [key]: q }))
      if (wheelRef.current.timer) clearTimeout(wheelRef.current.timer)
      wheelRef.current.timer = setTimeout(() => {
        wheelRef.current.timer = null
        const values = wheelRef.current.values
        wheelRef.current.values = {}
        // One scroll burst = one op.
        projectStore.dispatch({ type: 'plugin/setParams', instanceId, params: values })
        setPreview({})
      }, 400)
    }
    canvas.addEventListener('wheel', onWheel, { passive: false })
    return () => {
      canvas.removeEventListener('wheel', onWheel)
      if (wheelRef.current.timer) clearTimeout(wheelRef.current.timer)
    }
    // defs is module-constant data; refs cover the rest.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [instanceId])

  // ---------- Drawing ----------

  useEffect(() => {
    const colors = theme()
    const spectrumBuf: { current: Uint8Array<ArrayBuffer> | null } = { current: null }
    let raf = 0
    const gate = newPaintGate()
    let lastSelected: number | null = null

    const draw = (): void => {
      raf = requestAnimationFrame(draw)
      // Full rate only while audio flows or a param moves; a selection
      // change alone (the band ring) also forces a repaint.
      const painting = shouldPaint(gate, effectiveRef.current)
      if (!painting && lastSelected === selectedRef.current) return
      lastSelected = selectedRef.current
      const canvas = canvasRef.current
      if (!canvas) return
      const ctx = fitCanvas(canvas)
      if (!ctx) return
      const w = canvas.clientWidth
      const h = canvas.clientHeight
      ctx.clearRect(0, 0, w, h)

      // Grid: decades, 0 dB midline, ±6/±12 dB guides.
      ctx.strokeStyle = colors.grid
      ctx.fillStyle = colors.dim
      ctx.font = '8px ui-monospace, monospace'
      ctx.lineWidth = 1
      for (const [f, label] of [
        [100, '100'],
        [1000, '1k'],
        [10000, '10k']
      ] as const) {
        const x = Math.round(freqToX(f, w)) + 0.5
        ctx.globalAlpha = 0.6
        ctx.beginPath()
        ctx.moveTo(x, 0)
        ctx.lineTo(x, h)
        ctx.stroke()
        ctx.fillText(label, x + 2, h - 2)
      }
      for (const db of [-12, -6, 6, 12]) {
        const y = Math.round(gainToY(db, h)) + 0.5
        ctx.globalAlpha = 0.25
        ctx.beginPath()
        ctx.moveTo(0, y)
        ctx.lineTo(w, y)
        ctx.stroke()
      }
      ctx.globalAlpha = 0.6
      ctx.beginPath()
      ctx.moveTo(0, Math.round(h / 2) + 0.5)
      ctx.lineTo(w, Math.round(h / 2) + 0.5)
      ctx.stroke()
      ctx.globalAlpha = 1

      drawSpectrum(ctx, instanceId, w, h, colors.accent, spectrumBuf)

      const bands = bandsOf(effectiveRef.current)
      const active = bands.filter((b) => b.on)
      const selectedBand = active.find((b) => b.n === selectedRef.current)

      // The selected band's own response, faint, so its share of the total
      // is visible while shaping it.
      if (selectedBand) {
        const bq = responseOf(selectedBand)
        ctx.beginPath()
        for (let x = 0; x <= w; x++) {
          const y = gainToY(magnitudeDb(bq, xToFreq(x, w)), h)
          if (x === 0) ctx.moveTo(x, y)
          else ctx.lineTo(x, y)
        }
        ctx.strokeStyle = BAND_COLORS[(selectedBand.n - 1) % BAND_COLORS.length]
        ctx.globalAlpha = 0.4
        ctx.setLineDash([2, 3])
        ctx.stroke()
        ctx.setLineDash([])
        ctx.globalAlpha = 1
      }

      // Combined response.
      const responses = active.map(responseOf)
      ctx.beginPath()
      for (let x = 0; x <= w; x++) {
        const f = xToFreq(x, w)
        let db = 0
        for (const bq of responses) db += magnitudeDb(bq, f)
        const y = gainToY(Math.max(-RANGE_DB, Math.min(RANGE_DB, db)), h)
        if (x === 0) ctx.moveTo(x, y)
        else ctx.lineTo(x, y)
      }
      ctx.strokeStyle = colors.accent
      ctx.lineWidth = 1.5
      ctx.stroke()
      ctx.lineWidth = 1

      // Band handles.
      for (const band of active) {
        const bx = freqToX(band.freq, w)
        const by = GAINLESS.has(band.type) ? h / 2 : gainToY(band.gain, h)
        const color = BAND_COLORS[(band.n - 1) % BAND_COLORS.length]
        ctx.beginPath()
        ctx.arc(bx, by, 4, 0, Math.PI * 2)
        ctx.fillStyle = color
        ctx.fill()
        if (band.n === selectedRef.current) {
          ctx.beginPath()
          ctx.arc(bx, by, 7, 0, Math.PI * 2)
          ctx.strokeStyle = color
          ctx.stroke()
        }
      }
    }

    raf = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(raf)
  }, [instanceId, effectiveRef])

  // ---------- Selected band controls ----------

  const selectedBand = selected !== null ? bandsOf(effective)[selected - 1] : null

  return (
    <div>
      <canvas
        ref={canvasRef}
        className="fx-visual fx-eq-canvas"
        style={{ height: 120 }}
        title="Drag a point · double-click empty space to add a band · double-click a point to remove it · scroll to shape Q"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onDoubleClick={onDoubleClick}
      />
      {selectedBand && selectedBand.on ? (
        <div className="fx-eq-band">
          <div className="fx-eq-band-head">
            <span
              className="fx-eq-band-dot"
              style={{ background: BAND_COLORS[(selectedBand.n - 1) % BAND_COLORS.length] }}
            />
            <span className="fx-eq-band-title">Band {selectedBand.n}</span>
            <div className="fx-eq-types">
              {TYPE_LABELS.map((label, index) => (
                <button
                  key={label}
                  className={`fx-eq-type ${selectedBand.type === index ? 'fx-eq-type-active' : ''}`}
                  onClick={() => commitValues({ [`b${selectedBand.n}type`]: index })}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
          {[`b${selectedBand.n}freq`, `b${selectedBand.n}gain`, `b${selectedBand.n}q`]
            .filter((key) => !(GAINLESS.has(selectedBand.type) && key.endsWith('gain')))
            .map((key) => (
              <ParamSlider
                key={key}
                def={defs[key]}
                value={effective[key] ?? defs[key].default}
                onPreview={(v) => previewValues({ [key]: v })}
                onCommit={(v) => commitValues({ [key]: v })}
              />
            ))}
        </div>
      ) : (
        <div className="fx-eq-hint statusbar-dim">
          Click a point to edit it · double-click the graph to add a band
        </div>
      )}
    </div>
  )
}
