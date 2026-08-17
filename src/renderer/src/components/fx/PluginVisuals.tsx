import { useEffect, useRef } from 'react'
import type { EffectType } from '@core/model/effects'
import type { PluginInstanceId } from '@core/model/types'
import { audioEngine } from '@/state/audioInstance'
import { transport } from '@/state/transport'
import {
  bandpass,
  freqToX,
  highpass,
  lowpass,
  magnitudeDb,
  notch,
  peaking,
  shelf,
  xToFreq,
  type Biquad
} from '@/lib/biquad'
import { LFO_WAVE_TYPES } from '@core/model/effects'
import { saturate } from '@audio/saturation'
import { ParametricEq } from './ParametricEq'

/**
 * Per-effect visualizations for the builtin plugin cards. Live data
 * (spectrum, gain reduction) is polled from the engine's analysis handles
 * inside rAF loops — never through React state, matching the meters.
 * Curves are computed from the params prop, which includes in-flight
 * slider previews, so visuals track drags before the op lands.
 */

type Params = Readonly<Record<string, number>>

/**
 * Frame gate for the card visuals. At full rate only while audio can be
 * flowing (transport rolling) or a param is being dragged; otherwise the
 * loop idles at ~2 fps — enough to track dock resizes and theme changes —
 * and a hidden tab paints nothing. Ten open cards used to cost ten full
 * 60 fps analyser+canvas loops around the clock; now a stopped, untouched
 * dock costs effectively nothing.
 */
interface PaintGate {
  lastParams: unknown
  countdown: number
}

const IDLE_REPAINT_FRAMES = 30

export function newPaintGate(): PaintGate {
  return { lastParams: null, countdown: 0 }
}

export function shouldPaint(gate: PaintGate, params: unknown): boolean {
  if (document.hidden) return false
  if (transport.isPlaying || gate.lastParams !== params) {
    gate.lastParams = params
    gate.countdown = 0
    return true
  }
  if (gate.countdown > 0) {
    gate.countdown--
    return false
  }
  gate.countdown = IDLE_REPAINT_FRAMES
  return true
}

export function EffectVisual({
  type,
  instanceId,
  params
}: {
  type: EffectType
  instanceId: PluginInstanceId
  params: Params
}): React.JSX.Element {
  switch (type) {
    case 'paraeq':
      return <ParametricEq instanceId={instanceId} params={params} />
    case 'eq3':
      return <EqVisual instanceId={instanceId} params={params} />
    case 'compressor':
      return <CompressorVisual instanceId={instanceId} params={params} />
    case 'limiter':
      return <LimiterVisual instanceId={instanceId} params={params} />
    case 'delay':
      return <DelayVisual instanceId={instanceId} params={params} />
    case 'reverb':
      return <ReverbVisual instanceId={instanceId} params={params} />
    case 'reverbpro':
      return <ReverbProVisual instanceId={instanceId} params={params} />
    case 'saturator':
      return <SaturatorVisual instanceId={instanceId} params={params} />
    case 'lowpass':
    case 'highpass':
    case 'bandpass':
    case 'notch':
      return <FilterVisual type={type} instanceId={instanceId} params={params} />
    case 'lfo':
      return <LfoVisual params={params} />
    case 'sidechain':
      return <SidechainVisual params={params} />
  }
}

// ---------- Basic filters: response curve over a live output spectrum ----------

const FILTER_RANGE_DB = 30

function FilterVisual({
  type,
  instanceId,
  params
}: {
  type: 'lowpass' | 'highpass' | 'bandpass' | 'notch'
  instanceId: PluginInstanceId
  params: Params
}): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const paramsRef = useParamsRef(params)

  useEffect(() => {
    const colors = theme()
    const spectrumBuf: { current: Uint8Array<ArrayBuffer> | null } = { current: null }
    let raf = 0
    const gate = newPaintGate()

    const curveOf = (cutoff: number, q: number): Biquad => {
      switch (type) {
        case 'lowpass':
          return lowpass(cutoff, q)
        case 'highpass':
          return highpass(cutoff, q)
        case 'bandpass':
          return bandpass(cutoff, q)
        case 'notch':
          return notch(cutoff, q)
      }
    }

    const draw = (): void => {
      raf = requestAnimationFrame(draw)
      if (!shouldPaint(gate, paramsRef.current)) return
      const canvas = canvasRef.current
      if (!canvas) return
      const ctx = fitCanvas(canvas)
      if (!ctx) return
      const w = canvas.clientWidth
      const h = canvas.clientHeight
      ctx.clearRect(0, 0, w, h)

      // Grid: frequency decades + the 0 dB line.
      ctx.strokeStyle = colors.grid
      ctx.fillStyle = colors.dim
      ctx.font = '8px ui-monospace, monospace'
      ctx.lineWidth = 1
      ctx.globalAlpha = 0.6
      for (const [f, label] of [
        [100, '100'],
        [1000, '1k'],
        [10000, '10k']
      ] as const) {
        const x = Math.round(freqToX(f, w)) + 0.5
        ctx.beginPath()
        ctx.moveTo(x, 0)
        ctx.lineTo(x, h)
        ctx.stroke()
        ctx.fillText(label, x + 2, h - 2)
      }
      const zeroY = Math.round(h * 0.35) + 0.5
      ctx.beginPath()
      ctx.moveTo(0, zeroY)
      ctx.lineTo(w, zeroY)
      ctx.stroke()
      ctx.globalAlpha = 1

      drawSpectrum(ctx, instanceId, w, h, colors.dim, spectrumBuf)

      const p = paramsRef.current
      const bq = curveOf(p.cutoff ?? 1000, p.resonance ?? 0.71)
      ctx.beginPath()
      for (let x = 0; x <= w; x++) {
        const db = magnitudeDb(bq, xToFreq(x, w))
        const y = zeroY - (db / FILTER_RANGE_DB) * (h * 0.65)
        if (x === 0) ctx.moveTo(x, y)
        else ctx.lineTo(x, y)
      }
      ctx.strokeStyle = colors.accent
      ctx.lineWidth = 1.6
      ctx.stroke()
    }
    draw()
    return () => cancelAnimationFrame(raf)
  }, [type, instanceId, paramsRef])

  return <canvas ref={canvasRef} className="fx-visual" />
}

// ---------- LFO: one cycle of the modulation shape at its depth ----------

function LfoVisual({ params }: { params: Params }): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const paramsRef = useParamsRef(params)

  useEffect(() => {
    const colors = theme()
    let raf = 0
    const gate = newPaintGate()

    const waveAt = (phase: number, wave: string): number => {
      switch (wave) {
        case 'triangle':
          return 1 - 4 * Math.abs(((phase + 0.25) % 1) - 0.5)
        case 'square':
          return phase % 1 < 0.5 ? 1 : -1
        case 'sawtooth':
          return 2 * ((phase + 0.5) % 1) - 1
        default:
          return Math.sin(phase * 2 * Math.PI)
      }
    }

    const draw = (): void => {
      raf = requestAnimationFrame(draw)
      if (!shouldPaint(gate, paramsRef.current)) return
      const canvas = canvasRef.current
      if (!canvas) return
      const ctx = fitCanvas(canvas)
      if (!ctx) return
      const w = canvas.clientWidth
      const h = canvas.clientHeight
      ctx.clearRect(0, 0, w, h)

      const p = paramsRef.current
      const depth = Math.max(0, Math.min(1, p.depth ?? 0.5))
      const rate = p.rate ?? 4
      const waveIndex = Math.max(
        0,
        Math.min(LFO_WAVE_TYPES.length - 1, Math.round(p.wave ?? 0))
      )
      const wave = LFO_WAVE_TYPES[waveIndex]

      // Unity line (no modulation) at the top quarter.
      const unityY = Math.round(h * 0.2) + 0.5
      ctx.strokeStyle = colors.grid
      ctx.lineWidth = 1
      ctx.globalAlpha = 0.6
      ctx.beginPath()
      ctx.moveTo(0, unityY)
      ctx.lineTo(w, unityY)
      ctx.stroke()
      ctx.globalAlpha = 1
      ctx.fillStyle = colors.dim
      ctx.font = '8px ui-monospace, monospace'
      ctx.fillText(`${wave} · ${rate.toFixed(2)} Hz`, 4, h - 4)

      // The gain the effect actually applies: [1-depth, 1], animated at the
      // real rate so the picture moves like the sound.
      const t = (performance.now() / 1000) * rate
      ctx.beginPath()
      for (let x = 0; x <= w; x++) {
        const phase = t + (x / w) * 2 // two cycles across
        const gain = 1 - depth / 2 + (depth / 2) * waveAt(phase, wave)
        const y = unityY + (1 - gain) * (h * 0.75)
        if (x === 0) ctx.moveTo(x, y)
        else ctx.lineTo(x, y)
      }
      ctx.strokeStyle = colors.accent
      ctx.lineWidth = 1.6
      ctx.stroke()
    }
    draw()
    return () => cancelAnimationFrame(raf)
  }, [paramsRef])

  return <canvas ref={canvasRef} className="fx-visual" />
}

/**
 * The duck's gain over a bar of four imagined key hits: dips by `amount`,
 * recovers at the Response rate. Illustrative (the real key is another
 * track), but drawn from the same envelope math the effect applies, so the
 * knobs read truthfully.
 */
function SidechainVisual({ params }: { params: Params }): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const paramsRef = useParamsRef(params)

  useEffect(() => {
    const colors = theme()
    let raf = 0
    const gate = newPaintGate()

    const draw = (): void => {
      raf = requestAnimationFrame(draw)
      if (!shouldPaint(gate, paramsRef.current)) return
      const canvas = canvasRef.current
      if (!canvas) return
      const ctx = fitCanvas(canvas)
      if (!ctx) return
      const w = canvas.clientWidth
      const h = canvas.clientHeight
      ctx.clearRect(0, 0, w, h)

      const p = paramsRef.current
      const amount = Math.max(0, Math.min(1, p.amount ?? 0.8))
      const response = Math.max(0.5, p.response ?? 8)

      const unityY = Math.round(h * 0.2) + 0.5
      ctx.strokeStyle = colors.grid
      ctx.lineWidth = 1
      ctx.globalAlpha = 0.6
      ctx.beginPath()
      ctx.moveTo(0, unityY)
      ctx.lineTo(w, unityY)
      ctx.stroke()
      ctx.globalAlpha = 1
      ctx.fillStyle = colors.dim
      ctx.font = '8px ui-monospace, monospace'
      ctx.fillText(`duck ${(amount * 100).toFixed(0)}% · ${response.toFixed(1)} Hz`, 4, h - 4)

      // Four hits at 120 BPM across the width; the one-pole recovery uses
      // the same time constant the envelope lowpass gives the audio.
      const beatsShown = 4
      const secondsShown = beatsShown * 0.5
      const tau = 1 / (2 * Math.PI * response)
      ctx.beginPath()
      for (let x = 0; x <= w; x++) {
        const tInBeat = ((x / w) * secondsShown) % 0.5
        const gain = 1 - amount * Math.exp(-tInBeat / tau)
        const y = unityY + (1 - gain) * (h * 0.75)
        if (x === 0) ctx.moveTo(x, y)
        else ctx.lineTo(x, y)
      }
      ctx.strokeStyle = colors.accent
      ctx.lineWidth = 1.6
      ctx.stroke()
    }
    draw()
    return () => cancelAnimationFrame(raf)
  }, [paramsRef])

  return <canvas ref={canvasRef} className="fx-visual" />
}

// ---------- Drawing helpers ----------

export const theme = (): { bg: string; grid: string; dim: string; accent: string; warn: string } => {
  const style = getComputedStyle(document.documentElement)
  const v = (name: string, fallback: string): string =>
    style.getPropertyValue(name).trim() || fallback
  return {
    bg: v('--bg-0', '#141518'),
    grid: v('--border', '#2e3138'),
    dim: v('--text-dim', '#8a8f98'),
    accent: v('--accent', '#5b8def'),
    warn: v('--mute', '#e0b25b')
  }
}

/** Match the backing store to the CSS box (and DPR); returns null pre-layout. */
export function fitCanvas(canvas: HTMLCanvasElement): CanvasRenderingContext2D | null {
  const dpr = window.devicePixelRatio || 1
  const w = canvas.clientWidth
  const h = canvas.clientHeight
  if (w === 0 || h === 0) return null
  const bw = Math.round(w * dpr)
  const bh = Math.round(h * dpr)
  if (canvas.width !== bw || canvas.height !== bh) {
    canvas.width = bw
    canvas.height = bh
  }
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  return ctx
}

/** Keep the latest params readable from inside a rAF loop without restarting it. */
export function useParamsRef(params: Params): React.RefObject<Params> {
  const ref = useRef<Params>(params)
  ref.current = params
  return ref
}

/**
 * Draw a live output spectrum (if the plugin's nodes are in the graph)
 * as a filled area on a log-frequency axis. Shared by every card with a
 * spectrum tap.
 */
export function drawSpectrum(
  ctx: CanvasRenderingContext2D,
  instanceId: PluginInstanceId,
  w: number,
  h: number,
  fill: string,
  buf: { current: Uint8Array<ArrayBuffer> | null }
): void {
  const analyser = audioEngine.pluginAnalysis(instanceId)?.spectrum
  if (!analyser) return
  const bins = analyser.frequencyBinCount
  if (!buf.current || buf.current.length !== bins) buf.current = new Uint8Array(bins)
  analyser.getByteFrequencyData(buf.current)
  const nyquist = analyser.context.sampleRate / 2
  ctx.beginPath()
  ctx.moveTo(0, h)
  for (let x = 0; x <= w; x++) {
    const bin = Math.min(bins - 1, (xToFreq(x, w) / nyquist) * bins)
    const i = Math.floor(bin)
    const frac = bin - i
    const v = (buf.current[i] * (1 - frac) + buf.current[Math.min(bins - 1, i + 1)] * frac) / 255
    ctx.lineTo(x, h - v * h)
  }
  ctx.lineTo(w, h)
  ctx.closePath()
  ctx.globalAlpha = 0.28
  ctx.fillStyle = fill
  ctx.fill()
  ctx.globalAlpha = 0.55
  ctx.strokeStyle = fill
  ctx.lineWidth = 1
  ctx.stroke()
  ctx.globalAlpha = 1
}

/**
 * Instantaneous peak of an analyser's time-domain signal, in dBFS
 * (floored at -80). Used for the dynamics cards' input metering.
 */
function readPeakDb(
  analyser: AnalyserNode,
  buf: { current: Float32Array<ArrayBuffer> | null }
): number {
  if (!buf.current || buf.current.length !== analyser.fftSize) {
    buf.current = new Float32Array(analyser.fftSize)
  }
  analyser.getFloatTimeDomainData(buf.current)
  let peak = 0
  for (let i = 0; i < buf.current.length; i++) {
    const v = Math.abs(buf.current[i])
    if (v > peak) peak = v
  }
  return peak > 0 ? Math.max(-80, 20 * Math.log10(peak)) : -80
}

// ---------- 3-band EQ: response curve over a live output spectrum ----------

const EQ_RANGE_DB = 16

function EqVisual({
  instanceId,
  params
}: {
  instanceId: PluginInstanceId
  params: Params
}): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const paramsRef = useParamsRef(params)

  useEffect(() => {
    const colors = theme()
    const spectrumBuf: { current: Uint8Array<ArrayBuffer> | null } = { current: null }
    let raf = 0
    const gate = newPaintGate()

    const draw = (): void => {
      raf = requestAnimationFrame(draw)
      if (!shouldPaint(gate, paramsRef.current)) return
      const canvas = canvasRef.current
      if (!canvas) return
      const ctx = fitCanvas(canvas)
      if (!ctx) return
      const w = canvas.clientWidth
      const h = canvas.clientHeight
      ctx.clearRect(0, 0, w, h)

      // Grid: frequency decades + the 0 dB midline.
      ctx.strokeStyle = colors.grid
      ctx.fillStyle = colors.dim
      ctx.font = '8px ui-monospace, monospace'
      ctx.lineWidth = 1
      ctx.globalAlpha = 0.6
      for (const [f, label] of [
        [100, '100'],
        [1000, '1k'],
        [10000, '10k']
      ] as const) {
        const x = Math.round(freqToX(f, w)) + 0.5
        ctx.beginPath()
        ctx.moveTo(x, 0)
        ctx.lineTo(x, h)
        ctx.stroke()
        ctx.fillText(label, x + 2, h - 2)
      }
      ctx.beginPath()
      ctx.moveTo(0, Math.round(h / 2) + 0.5)
      ctx.lineTo(w, Math.round(h / 2) + 0.5)
      ctx.stroke()
      ctx.globalAlpha = 1

      // Live output spectrum behind the curve (only while nodes exist).
      drawSpectrum(ctx, instanceId, w, h, colors.accent, spectrumBuf)

      // Combined response of the three bands (same math as the audio nodes).
      const p = paramsRef.current
      const bands = [
        shelf(200, p.low ?? 0, false),
        peaking(p.midFreq ?? 1000, 0.9, p.mid ?? 0),
        shelf(4000, p.high ?? 0, true)
      ]
      ctx.beginPath()
      for (let x = 0; x <= w; x++) {
        const f = xToFreq(x, w)
        let db = 0
        for (const band of bands) db += magnitudeDb(band, f)
        const y = h / 2 - (db / EQ_RANGE_DB) * (h / 2)
        if (x === 0) ctx.moveTo(x, y)
        else ctx.lineTo(x, y)
      }
      ctx.strokeStyle = colors.accent
      ctx.lineWidth = 1.5
      ctx.stroke()
    }

    raf = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(raf)
  }, [instanceId, paramsRef])

  return <canvas ref={canvasRef} className="fx-visual" style={{ height: 80 }} />
}

// ---------- Compressor: transfer curve + live gain reduction ----------

const COMP_KNEE = 12 // matches the DynamicsCompressorNode knee in audio/effects.ts
const COMP_FLOOR = -60
const GR_SCALE = 24

/** Soft-knee downward compression transfer (dB in → dB out), plus makeup. */
function compTransfer(x: number, t: number, r: number, knee: number, makeup: number): number {
  let y: number
  if (2 * (x - t) < -knee) y = x
  else if (2 * (x - t) <= knee) y = x + ((1 / r - 1) * Math.pow(x - t + knee / 2, 2)) / (2 * knee)
  else y = t + (x - t) / r
  return y + makeup
}

function CompressorVisual({
  instanceId,
  params
}: {
  instanceId: PluginInstanceId
  params: Params
}): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const paramsRef = useParamsRef(params)

  useEffect(() => {
    const colors = theme()
    let raf = 0
    let shownGr = 0
    let shownIn = -80
    const levelBuf: { current: Float32Array<ArrayBuffer> | null } = { current: null }
    const spectrumBuf: { current: Uint8Array<ArrayBuffer> | null } = { current: null }
    const gate = newPaintGate()

    const draw = (): void => {
      raf = requestAnimationFrame(draw)
      if (!shouldPaint(gate, paramsRef.current)) return
      const canvas = canvasRef.current
      if (!canvas) return
      const ctx = fitCanvas(canvas)
      if (!ctx) return
      const w = canvas.clientWidth
      const h = canvas.clientHeight
      ctx.clearRect(0, 0, w, h)

      // Live output spectrum behind everything, like the EQ card.
      drawSpectrum(ctx, instanceId, w, h, colors.accent, spectrumBuf)

      const p = paramsRef.current
      const threshold = p.threshold ?? -24
      const ratio = p.ratio ?? 4
      const makeup = p.makeup ?? 0

      // Left square: dB-in → dB-out transfer curve.
      const s = h
      const toX = (dbIn: number): number => ((dbIn - COMP_FLOOR) / -COMP_FLOOR) * s
      const toY = (dbOut: number): number => h - ((dbOut - COMP_FLOOR) / -COMP_FLOOR) * h

      ctx.save()
      ctx.beginPath()
      ctx.rect(0, 0, s, h)
      ctx.clip()
      // Unity line and threshold marker.
      ctx.globalAlpha = 0.5
      ctx.strokeStyle = colors.grid
      ctx.setLineDash([3, 3])
      ctx.beginPath()
      ctx.moveTo(toX(COMP_FLOOR), toY(COMP_FLOOR))
      ctx.lineTo(toX(0), toY(0))
      ctx.stroke()
      ctx.setLineDash([])
      ctx.beginPath()
      ctx.moveTo(Math.round(toX(threshold)) + 0.5, 0)
      ctx.lineTo(Math.round(toX(threshold)) + 0.5, h)
      ctx.stroke()
      ctx.globalAlpha = 1
      // The transfer curve itself.
      ctx.beginPath()
      for (let x = 0; x <= s; x++) {
        const dbIn = COMP_FLOOR + (x / s) * -COMP_FLOOR
        const y = toY(compTransfer(dbIn, threshold, ratio, COMP_KNEE, makeup))
        if (x === 0) ctx.moveTo(x, y)
        else ctx.lineTo(x, y)
      }
      ctx.strokeStyle = colors.accent
      ctx.lineWidth = 1.5
      ctx.stroke()

      // A dot riding the curve at the live input level: WHERE on the
      // curve the compressor is operating right now.
      const analysis = audioEngine.pluginAnalysis(instanceId)
      if (analysis?.input) {
        const inDb = readPeakDb(analysis.input, levelBuf)
        shownIn = inDb > shownIn ? inDb : Math.max(-80, shownIn - 1.2)
        if (shownIn > COMP_FLOOR) {
          const dotIn = Math.min(0, shownIn)
          const y = toY(compTransfer(dotIn, threshold, ratio, COMP_KNEE, makeup))
          ctx.beginPath()
          ctx.arc(toX(dotIn), y, 3, 0, Math.PI * 2)
          ctx.fillStyle = colors.warn
          ctx.fill()
        }
      }
      ctx.restore()
      ctx.strokeStyle = colors.grid
      ctx.strokeRect(0.5, 0.5, s - 1, h - 1)

      // Right: live gain-reduction bar, top-down like a hardware GR meter.
      const gr = analysis?.reductionDb ? Math.max(0, -analysis.reductionDb()) : 0
      shownGr = Math.max(gr, shownGr * 0.9)
      const barX = w - 16
      ctx.strokeStyle = colors.grid
      ctx.strokeRect(barX + 0.5, 0.5, 10 - 1, h - 1)
      const grH = Math.min(1, shownGr / GR_SCALE) * (h - 2)
      ctx.fillStyle = colors.warn
      ctx.fillRect(barX + 1, 1, 8, grH)

      ctx.fillStyle = colors.dim
      ctx.font = '9px ui-monospace, monospace'
      ctx.textAlign = 'right'
      ctx.fillText('GR', barX - 5, 10)
      ctx.fillStyle = shownGr > 0.1 ? colors.warn : colors.dim
      ctx.fillText(`${shownGr.toFixed(1)} dB`, barX - 5, h - 4)
      ctx.textAlign = 'left'
    }

    raf = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(raf)
  }, [instanceId, paramsRef])

  return <canvas ref={canvasRef} className="fx-visual" style={{ height: 80 }} />
}

// ---------- Limiter: live gain reduction against the ceiling ----------

function LimiterVisual({
  instanceId,
  params
}: {
  instanceId: PluginInstanceId
  params: Params
}): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const paramsRef = useParamsRef(params)

  useEffect(() => {
    const colors = theme()
    let raf = 0
    let shownGr = 0
    let shownIn = -80
    const levelBuf: { current: Float32Array<ArrayBuffer> | null } = { current: null }
    const spectrumBuf: { current: Uint8Array<ArrayBuffer> | null } = { current: null }
    const LIM_FLOOR = -30 // meter scale: -30..0 dB
    const gate = newPaintGate()

    const draw = (): void => {
      raf = requestAnimationFrame(draw)
      if (!shouldPaint(gate, paramsRef.current)) return
      const canvas = canvasRef.current
      if (!canvas) return
      const ctx = fitCanvas(canvas)
      if (!ctx) return
      const w = canvas.clientWidth
      const h = canvas.clientHeight
      ctx.clearRect(0, 0, w, h)

      // Live output spectrum behind the meters, like the EQ card.
      drawSpectrum(ctx, instanceId, w, h, colors.accent, spectrumBuf)

      const analysis = audioEngine.pluginAnalysis(instanceId)
      const gr = analysis?.reductionDb ? Math.max(0, -analysis.reductionDb()) : 0
      shownGr = Math.max(gr, shownGr * 0.9)
      const inDb = analysis?.input ? readPeakDb(analysis.input, levelBuf) : -80
      shownIn = inDb > shownIn ? inDb : Math.max(-80, shownIn - 1.2)

      const ceiling = paramsRef.current.ceiling ?? -1
      const barX = 24
      const barW = w - barX - 54
      const toX = (db: number): number =>
        barX + Math.min(1, Math.max(0, (db - LIM_FLOOR) / -LIM_FLOOR)) * barW
      ctx.font = '9px ui-monospace, monospace'

      // IN: the level arriving at the limiter, against the ceiling tick.
      const inY = 8
      ctx.strokeStyle = colors.grid
      ctx.strokeRect(barX + 0.5, inY + 0.5, barW - 1, 7)
      if (shownIn > LIM_FLOOR) {
        ctx.fillStyle = colors.accent
        ctx.globalAlpha = 0.7
        ctx.fillRect(barX + 1, inY + 1, toX(Math.min(0, shownIn)) - barX - 1, 6)
        ctx.globalAlpha = 1
      }
      const cx = Math.round(toX(ceiling)) + 0.5
      ctx.strokeStyle = colors.warn
      ctx.beginPath()
      ctx.moveTo(cx, inY - 2)
      ctx.lineTo(cx, inY + 10)
      ctx.stroke()
      ctx.fillStyle = colors.dim
      ctx.fillText('IN', 4, inY + 7)
      ctx.textAlign = 'right'
      ctx.fillText(`${shownIn <= LIM_FLOOR ? '—' : shownIn.toFixed(1)} dB`, w - 4, inY + 7)
      ctx.textAlign = 'left'

      // GR: attenuation grows leftward, like a hardware meter. 0..12 dB.
      const grY = h - 16
      ctx.strokeStyle = colors.grid
      ctx.strokeRect(barX + 0.5, grY + 0.5, barW - 1, 7)
      const grW = Math.min(1, shownGr / 12) * (barW - 2)
      ctx.fillStyle = colors.warn
      ctx.fillRect(barX + barW - 1 - grW, grY + 1, grW, 6)
      ctx.fillStyle = colors.dim
      ctx.fillText('GR', 4, grY + 7)
      ctx.textAlign = 'right'
      ctx.fillStyle = shownGr > 0.1 ? colors.warn : colors.dim
      ctx.fillText(`${shownGr.toFixed(1)} dB`, w - 4, grY + 7)
      ctx.textAlign = 'left'
    }

    raf = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(raf)
  }, [instanceId, paramsRef])

  return <canvas ref={canvasRef} className="fx-visual" style={{ height: 52 }} />
}

// ---------- Delay: echo taps from time / feedback / mix ----------

function DelayVisual({
  instanceId,
  params
}: {
  instanceId: PluginInstanceId
  params: Params
}): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const paramsRef = useParamsRef(params)

  useEffect(() => {
    const colors = theme()
    const spectrumBuf: { current: Uint8Array<ArrayBuffer> | null } = { current: null }
    let raf = 0
    const gate = newPaintGate()

    const draw = (): void => {
      raf = requestAnimationFrame(draw)
      if (!shouldPaint(gate, paramsRef.current)) return
      const canvas = canvasRef.current
      if (!canvas) return
      const ctx = fitCanvas(canvas)
      if (!ctx) return
      const w = canvas.clientWidth
      const h = canvas.clientHeight
      ctx.clearRect(0, 0, w, h)

      const p = paramsRef.current
      const time = p.time ?? 0.3
      const feedback = p.feedback ?? 0.35
      const mix = p.mix ?? 0.25

      // Live output spectrum (dry + echoes) behind the tap diagram.
      drawSpectrum(ctx, instanceId, w, h, colors.accent, spectrumBuf)

      const window = Math.max(1.2, time * 5)
      const base = h - 10
      ctx.strokeStyle = colors.grid
      ctx.beginPath()
      ctx.moveTo(0, base + 0.5)
      ctx.lineTo(w, base + 0.5)
      ctx.stroke()

      const bar = (t: number, amp: number, color: string): void => {
        const x = Math.round((t / window) * (w - 6)) + 2
        ctx.fillStyle = color
        ctx.fillRect(x, base - amp * (base - 6), 3, amp * (base - 6))
      }
      // Dry signal, then each feedback repeat until inaudible.
      bar(0, 1 - mix * 0.5, colors.dim)
      for (let k = 1; k <= 24; k++) {
        const amp = mix * Math.pow(feedback, k - 1)
        if (amp < 0.02 || k * time > window) break
        bar(k * time, amp, colors.accent)
      }
      ctx.fillStyle = colors.dim
      ctx.font = '8px ui-monospace, monospace'
      ctx.textAlign = 'right'
      ctx.fillText(`${window.toFixed(1)}s`, w - 2, h - 1)
      ctx.textAlign = 'left'
    }

    raf = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(raf)
  }, [instanceId, paramsRef])

  return <canvas ref={canvasRef} className="fx-visual" style={{ height: 56 }} />
}

// ---------- Reverb: decay envelope from decay / mix ----------

function ReverbVisual({
  instanceId,
  params
}: {
  instanceId: PluginInstanceId
  params: Params
}): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const paramsRef = useParamsRef(params)

  useEffect(() => {
    const colors = theme()
    const spectrumBuf: { current: Uint8Array<ArrayBuffer> | null } = { current: null }
    let raf = 0
    const gate = newPaintGate()

    const draw = (): void => {
      raf = requestAnimationFrame(draw)
      if (!shouldPaint(gate, paramsRef.current)) return
      const canvas = canvasRef.current
      if (!canvas) return
      const ctx = fitCanvas(canvas)
      if (!ctx) return
      const w = canvas.clientWidth
      const h = canvas.clientHeight
      ctx.clearRect(0, 0, w, h)

      const p = paramsRef.current
      const decay = p.decay ?? 1.8
      const mix = p.mix ?? 0.25

      // Live output spectrum (dry + tail) behind the envelope.
      drawSpectrum(ctx, instanceId, w, h, colors.accent, spectrumBuf)

      const base = h - 10
      ctx.strokeStyle = colors.grid
      ctx.beginPath()
      ctx.moveTo(0, base + 0.5)
      ctx.lineTo(w, base + 0.5)
      ctx.stroke()

      // Dry impulse, then the tail: the same (1 - t/decay)^2.5 envelope
      // the convolver's generated impulse uses, scaled by the wet mix.
      ctx.fillStyle = colors.dim
      ctx.fillRect(2, base - (1 - mix * 0.5) * (base - 6), 3, (1 - mix * 0.5) * (base - 6))
      ctx.beginPath()
      ctx.moveTo(6, base)
      for (let x = 6; x <= w - 2; x++) {
        const t = ((x - 6) / (w - 8)) * decay
        const amp = mix * Math.pow(Math.max(0, 1 - t / decay), 2.5)
        ctx.lineTo(x, base - amp * (base - 6))
      }
      ctx.lineTo(w - 2, base)
      ctx.closePath()
      ctx.globalAlpha = 0.35
      ctx.fillStyle = colors.accent
      ctx.fill()
      ctx.globalAlpha = 1

      ctx.fillStyle = colors.dim
      ctx.font = '8px ui-monospace, monospace'
      ctx.textAlign = 'right'
      ctx.fillText(`${decay.toFixed(1)}s`, w - 2, h - 1)
      ctx.textAlign = 'left'
    }

    raf = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(raf)
  }, [instanceId, paramsRef])

  return <canvas ref={canvasRef} className="fx-visual" style={{ height: 56 }} />
}

// ---------- Reverb Pro: pre-delay gap + damped exponential tail ----------

function ReverbProVisual({
  instanceId,
  params
}: {
  instanceId: PluginInstanceId
  params: Params
}): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const paramsRef = useParamsRef(params)

  useEffect(() => {
    const colors = theme()
    const spectrumBuf: { current: Uint8Array<ArrayBuffer> | null } = { current: null }
    let raf = 0
    const gate = newPaintGate()

    const draw = (): void => {
      raf = requestAnimationFrame(draw)
      if (!shouldPaint(gate, paramsRef.current)) return
      const canvas = canvasRef.current
      if (!canvas) return
      const ctx = fitCanvas(canvas)
      if (!ctx) return
      const w = canvas.clientWidth
      const h = canvas.clientHeight
      ctx.clearRect(0, 0, w, h)

      const p = paramsRef.current
      const decay = p.decay ?? 2.4
      const predelaySec = (p.predelay ?? 20) / 1000
      const damping = Math.max(0, Math.min(1, p.damping ?? 0.5))
      const size = Math.max(0, Math.min(1, p.size ?? 0.7))
      const mix = p.mix ?? 0.3

      // Live output spectrum (dry + tail) behind the envelope.
      drawSpectrum(ctx, instanceId, w, h, colors.accent, spectrumBuf)

      const base = h - 10
      ctx.strokeStyle = colors.grid
      ctx.beginPath()
      ctx.moveTo(0, base + 0.5)
      ctx.lineTo(w, base + 0.5)
      ctx.stroke()

      // Dry impulse at t=0, then the tail after the pre-delay gap: the same
      // exponential envelope (with attack bloom) the generated IR uses,
      // scaled by the wet mix. Damping dims the fill toward the tail's end.
      const window = predelaySec + decay
      const toX = (t: number): number => 6 + (t / window) * (w - 8)
      ctx.fillStyle = colors.dim
      ctx.fillRect(2, base - (1 - mix * 0.5) * (base - 6), 3, (1 - mix * 0.5) * (base - 6))
      const buildSec = 0.004 + 0.1 * size
      ctx.beginPath()
      ctx.moveTo(toX(predelaySec), base)
      for (let x = Math.round(toX(predelaySec)); x <= w - 2; x++) {
        const t = ((x - 6) / (w - 8)) * window - predelaySec
        if (t < 0) continue
        const attack = Math.min(1, t / buildSec)
        const amp = mix * Math.pow(10, (-3 * t) / decay) * attack * attack
        ctx.lineTo(x, base - amp * (base - 6))
      }
      ctx.lineTo(w - 2, base)
      ctx.closePath()
      ctx.globalAlpha = 0.2 + 0.25 * (1 - damping)
      ctx.fillStyle = colors.accent
      ctx.fill()
      ctx.globalAlpha = 1

      ctx.fillStyle = colors.dim
      ctx.font = '8px ui-monospace, monospace'
      ctx.textAlign = 'right'
      ctx.fillText(`${decay.toFixed(1)}s`, w - 2, h - 1)
      ctx.textAlign = 'left'
      if (predelaySec > 0.001) {
        ctx.fillText(`${Math.round(predelaySec * 1000)}ms`, toX(0), h - 1)
      }
    }

    raf = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(raf)
  }, [instanceId, paramsRef])

  return <canvas ref={canvasRef} className="fx-visual" style={{ height: 56 }} />
}

// ---------- Saturator: transfer curve over a live output spectrum ----------

function SaturatorVisual({
  instanceId,
  params
}: {
  instanceId: PluginInstanceId
  params: Params
}): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const paramsRef = useParamsRef(params)

  useEffect(() => {
    const colors = theme()
    const spectrumBuf: { current: Uint8Array<ArrayBuffer> | null } = { current: null }
    let raf = 0
    const gate = newPaintGate()

    const draw = (): void => {
      raf = requestAnimationFrame(draw)
      if (!shouldPaint(gate, paramsRef.current)) return
      const canvas = canvasRef.current
      if (!canvas) return
      const ctx = fitCanvas(canvas)
      if (!ctx) return
      const w = canvas.clientWidth
      const h = canvas.clientHeight
      ctx.clearRect(0, 0, w, h)

      // Live output spectrum behind the curve, like the EQ card.
      drawSpectrum(ctx, instanceId, w, h, colors.accent, spectrumBuf)

      const p = paramsRef.current
      const drive = p.drive ?? 6
      const mix = p.mix ?? 1

      // Transfer square: x in → y out over ±1.1, unity diagonal dashed.
      const s = h
      const range = 1.1
      const toX = (v: number): number => ((v + range) / (2 * range)) * s
      const toY = (v: number): number => h - ((v + range) / (2 * range)) * h
      ctx.save()
      ctx.beginPath()
      ctx.rect(0, 0, s, h)
      ctx.clip()
      ctx.globalAlpha = 0.5
      ctx.strokeStyle = colors.grid
      ctx.setLineDash([3, 3])
      ctx.beginPath()
      ctx.moveTo(toX(-range), toY(-range))
      ctx.lineTo(toX(range), toY(range))
      ctx.stroke()
      ctx.setLineDash([])
      ctx.globalAlpha = 1
      // The dry/wet-blended transfer the insert applies (the shaper clamps
      // beyond ±1, exactly like the WaveShaper's curve range).
      ctx.beginPath()
      for (let x = 0; x <= s; x++) {
        const vin = -range + (x / s) * 2 * range
        const clipped = Math.max(-1, Math.min(1, vin))
        const vout = mix * saturate(clipped, drive) + (1 - mix) * vin
        const y = toY(vout)
        if (x === 0) ctx.moveTo(x, y)
        else ctx.lineTo(x, y)
      }
      ctx.strokeStyle = colors.accent
      ctx.lineWidth = 1.6
      ctx.stroke()
      ctx.restore()
      ctx.strokeStyle = colors.grid
      ctx.strokeRect(0.5, 0.5, s - 1, h - 1)

      ctx.fillStyle = colors.dim
      ctx.font = '9px ui-monospace, monospace'
      ctx.textAlign = 'right'
      ctx.fillText(`${drive.toFixed(1)} dB`, w - 4, h - 4)
      ctx.textAlign = 'left'
    }

    raf = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(raf)
  }, [instanceId, paramsRef])

  return <canvas ref={canvasRef} className="fx-visual" style={{ height: 80 }} />
}
