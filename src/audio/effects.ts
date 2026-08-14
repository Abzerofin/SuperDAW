import type { EffectType } from '@core/model/effects'
import { EFFECT_TYPES, LFO_WAVE_TYPES, PARAEQ_BANDS, PARAEQ_FILTER_TYPES } from '@core/model/effects'
import { builtinEffectDescriptor } from '@core/plugins/builtin'
import type { BackendNodeId, IAudioBackend } from './backend'
import { impulseBufferId, makeImpulse } from './impulse'
import type { PluginAnalysis, PluginNodes, PluginProvider } from './pluginRegistry'

/**
 * Builders for the builtin insert effects, exposed as PluginProviders.
 *
 * The FILTER family (paraeq, eq3, lowpass/highpass/bandpass/notch) builds
 * from backend primitives — createNode('biquad') + scheduleParam — so ONE
 * definition runs on the Web Audio backend today and the native backend
 * identically (docs/NATIVE_AUDIO_BACKEND.md §3: primitives are ported,
 * effects are not duplicated). The remaining effects (compressor,
 * limiter, delay, reverb, lfo) still build Web Audio node graphs behind
 * the `backend.webAudio` escape and return null on backends without it —
 * the engine bypasses them like missing plugins until their primitives
 * land. Analysis taps are Web-Audio-only either way (the UI consumes
 * AnalyserNodes; phase 2's tap system replaces that app-wide).
 */

const SMOOTH = 0.02

const dbToGain = (db: number): number => Math.pow(10, db / 20)

/** One smoothed value push — the AudioParam setTargetAtTime idiom. */
function smooth(
  backend: IAudioBackend,
  node: BackendNodeId,
  param: string,
  value: number,
  when: number
): void {
  backend.scheduleParam(node, param, [
    { kind: 'setTarget', value, time: when, timeConstant: SMOOTH }
  ])
}

function setNow(backend: IAudioBackend, node: BackendNodeId, param: string, value: number): void {
  backend.scheduleParam(node, param, [{ kind: 'setValue', value, time: 0 }])
}

/**
 * A pass-through output gain with (where Web Audio exists) a spectrum
 * analyser hanging off the FEEDING node: the engine calls
 * `disconnect(output)` on every chain rewire, severing ALL of the output
 * node's connections — so the analyser must tap the internal node, which
 * rewires never touch.
 */
function tapOut(
  backend: IAudioBackend,
  from: BackendNodeId
): { out: BackendNodeId; analysis?: PluginAnalysis; disposeTap(): void } {
  const out = backend.createNode('gain')
  backend.connect(from, out)
  const wa = backend.webAudio
  if (!wa) return { out, disposeTap: () => {} }
  const analyser = wa.ctx.createAnalyser()
  analyser.fftSize = 2048
  analyser.smoothingTimeConstant = 0.8
  wa.nodeOf(from).connect(analyser)
  return {
    out,
    analysis: { spectrum: analyser },
    disposeTap: () => analyser.disconnect()
  }
}

/**
 * The dynamics cards' extra observation points: a PRE-compression level
 * tap and the live gain-reduction readout. Both are Web-Audio-shaped
 * (an AnalyserNode; the node's own `reduction`), so under other backends
 * they are simply absent and the card draws what it can — the same
 * stance the spectrum tap takes.
 */
function dynamicsTaps(
  backend: IAudioBackend,
  input: BackendNodeId,
  compressor: BackendNodeId
): { analysis: Partial<PluginAnalysis>; dispose(): void } {
  const wa = backend.webAudio
  if (!wa) return { analysis: {}, dispose: () => {} }
  const inTap = wa.ctx.createAnalyser()
  inTap.fftSize = 1024
  wa.nodeOf(input).connect(inTap)
  const node = wa.nodeOf(compressor) as DynamicsCompressorNode
  return {
    analysis: { input: inTap, reductionDb: () => node.reduction },
    dispose: () => inTap.disconnect()
  }
}

/**
 * One biquad as a standalone insert — the basic filter family. Shares the
 * paraeq Q convention: the param is linear RBJ Q, converted to dB where
 * Web Audio expects it (lowpass/highpass).
 */
function basicFilter(type: 'lowpass' | 'highpass' | 'bandpass' | 'notch', defaultCutoff: number) {
  return (backend: IAudioBackend): PluginNodes => {
    const filter = backend.createNode('biquad', { type })
    setNow(backend, filter, 'frequency', defaultCutoff)
    const { out, analysis, disposeTap } = tapOut(backend, filter)
    return {
      input: filter,
      output: out,
      analysis,
      apply(p, when) {
        smooth(backend, filter, 'frequency', p.cutoff ?? defaultCutoff, when)
        const q = p.resonance ?? 0.71
        const nodeQ = type === 'lowpass' || type === 'highpass' ? 20 * Math.log10(q) : q
        smooth(backend, filter, 'Q', nodeQ, when)
      },
      dispose() {
        backend.disposeNode(filter)
        backend.disposeNode(out)
        disposeTap()
      }
    }
  }
}

type Builder = (backend: IAudioBackend) => PluginNodes | null

const BUILDERS: Record<EffectType, Builder> = {
  paraeq(backend) {
    // One biquad per band slot, chained. Disabled slots are parked as
    // zero-gain peaking filters — audibly transparent — so the chain
    // never needs rewiring when bands are placed or removed.
    const filters: BackendNodeId[] = []
    const currentTypes: string[] = []
    for (let i = 0; i < PARAEQ_BANDS; i++) {
      const f = backend.createNode('biquad', { type: 'peaking' })
      currentTypes.push('peaking')
      setNow(backend, f, 'gain', 0)
      if (i > 0) backend.connect(filters[i - 1], f)
      filters.push(f)
    }
    const { out, analysis, disposeTap } = tapOut(backend, filters[filters.length - 1])
    return {
      input: filters[0],
      output: out,
      analysis,
      apply(p, when) {
        filters.forEach((f, i) => {
          const n = i + 1
          const on = (p[`b${n}on`] ?? 0) >= 0.5
          const typeIndex = Math.max(
            0,
            Math.min(PARAEQ_FILTER_TYPES.length - 1, Math.round(p[`b${n}type`] ?? 0))
          )
          const type = on ? PARAEQ_FILTER_TYPES[typeIndex] : 'peaking'
          if (currentTypes[i] !== type) {
            currentTypes[i] = type
            backend.configureNode(f, { type }) // not a param; switches are instant
          }
          smooth(backend, f, 'frequency', p[`b${n}freq`] ?? 1000, when)
          smooth(backend, f, 'gain', on ? (p[`b${n}gain`] ?? 0) : 0, when)
          // Web Audio interprets Q in dB for lowpass/highpass; our param is
          // the linear RBJ Q, so convert to keep the drawn curve honest.
          const q = p[`b${n}q`] ?? 1
          const nodeQ = type === 'lowpass' || type === 'highpass' ? 20 * Math.log10(q) : q
          smooth(backend, f, 'Q', nodeQ, when)
        })
      },
      dispose() {
        for (const f of filters) backend.disposeNode(f)
        backend.disposeNode(out)
        disposeTap()
      }
    }
  },

  eq3(backend) {
    const low = backend.createNode('biquad', { type: 'lowshelf' })
    setNow(backend, low, 'frequency', 200)
    const mid = backend.createNode('biquad', { type: 'peaking' })
    setNow(backend, mid, 'Q', 0.9)
    const high = backend.createNode('biquad', { type: 'highshelf' })
    setNow(backend, high, 'frequency', 4000)
    backend.connect(low, mid)
    backend.connect(mid, high)
    const { out, analysis, disposeTap } = tapOut(backend, high)
    return {
      input: low,
      output: out,
      analysis,
      apply(p, when) {
        smooth(backend, low, 'gain', p.low ?? 0, when)
        smooth(backend, mid, 'gain', p.mid ?? 0, when)
        smooth(backend, mid, 'frequency', p.midFreq ?? 1000, when)
        smooth(backend, high, 'gain', p.high ?? 0, when)
      },
      dispose() {
        backend.disposeNode(low)
        backend.disposeNode(mid)
        backend.disposeNode(high)
        backend.disposeNode(out)
        disposeTap()
      }
    }
  },

  compressor(backend) {
    // Input gain (unity) exists so the card can watch the PRE-compression
    // level — the dot riding the transfer curve.
    const input = backend.createNode('gain')
    const comp = backend.createNode('compressor')
    setNow(backend, comp, 'knee', 12)
    const makeup = backend.createNode('gain')
    backend.connect(input, comp)
    backend.connect(comp, makeup)
    const { out, analysis: spectrumOnly, disposeTap } = tapOut(backend, makeup)
    // The pre-compression tap and the gain-reduction readout are UI-only
    // and Web-Audio-shaped (an AnalyserNode, the node's own `reduction`).
    const inTap = dynamicsTaps(backend, input, comp)
    return {
      input,
      output: out,
      analysis: spectrumOnly ? { ...spectrumOnly, ...inTap.analysis } : undefined,
      apply(p, when) {
        smooth(backend, comp, 'threshold', p.threshold ?? -24, when)
        smooth(backend, comp, 'ratio', p.ratio ?? 4, when)
        smooth(backend, comp, 'attack', p.attack ?? 0.01, when)
        smooth(backend, comp, 'release', p.release ?? 0.25, when)
        smooth(backend, makeup, 'gain', dbToGain(p.makeup ?? 0), when)
      },
      dispose() {
        for (const id of [input, comp, makeup, out]) backend.disposeNode(id)
        disposeTap()
        inTap.dispose()
      }
    }
  },

  limiter(backend) {
    // A hard-kneed, fast, high-ratio compressor — the standard brickwall
    // approximation over the same primitive.
    const input = backend.createNode('gain')
    const comp = backend.createNode('compressor')
    setNow(backend, comp, 'knee', 0)
    setNow(backend, comp, 'ratio', 20)
    setNow(backend, comp, 'attack', 0.002)
    backend.connect(input, comp)
    const { out, analysis: spectrumOnly, disposeTap } = tapOut(backend, comp)
    const inTap = dynamicsTaps(backend, input, comp)
    return {
      input,
      output: out,
      analysis: spectrumOnly ? { ...spectrumOnly, ...inTap.analysis } : undefined,
      apply(p, when) {
        smooth(backend, comp, 'threshold', p.ceiling ?? -1, when)
        smooth(backend, comp, 'release', p.release ?? 0.1, when)
      },
      dispose() {
        for (const id of [input, comp, out]) backend.disposeNode(id)
        disposeTap()
        inTap.dispose()
      }
    }
  },

  delay(backend) {
    // Backend primitives throughout: the feedback loop rides the seam's
    // in-cycle delay rule (one-block granularity), which both backends
    // implement — Web Audio natively, the native engine by construction.
    const input = backend.createNode('gain')
    const mixed = backend.createNode('gain')
    const dry = backend.createNode('gain')
    const wet = backend.createNode('gain')
    const delay = backend.createNode('delay', { maxDelay: 2 })
    const feedback = backend.createNode('gain')
    backend.connect(input, dry)
    backend.connect(dry, mixed)
    backend.connect(input, delay)
    backend.connect(delay, wet)
    backend.connect(wet, mixed)
    backend.connect(delay, feedback)
    backend.connect(feedback, delay)
    const { out, analysis, disposeTap } = tapOut(backend, mixed)
    return {
      input,
      output: out,
      analysis,
      apply(p, when) {
        smooth(backend, delay, 'delayTime', p.time ?? 0.3, when)
        smooth(backend, feedback, 'gain', p.feedback ?? 0.35, when)
        const mix = p.mix ?? 0.25
        smooth(backend, wet, 'gain', mix, when)
        smooth(backend, dry, 'gain', 1 - mix * 0.5, when)
      },
      dispose() {
        for (const id of [input, mixed, dry, wet, delay, feedback, out]) {
          backend.disposeNode(id)
        }
        disposeTap()
      }
    }
  },

  reverb(backend) {
    const input = backend.createNode('gain')
    const mixed = backend.createNode('gain')
    const dry = backend.createNode('gain')
    const wet = backend.createNode('gain')
    const convolver = backend.createNode('convolver')
    let impulseDecay = -1
    backend.connect(input, dry)
    backend.connect(dry, mixed)
    backend.connect(input, convolver)
    backend.connect(convolver, wet)
    backend.connect(wet, mixed)
    const { out, analysis, disposeTap } = tapOut(backend, mixed)
    // Impulse buffers are shared by decay across every reverb instance —
    // the tail is deterministic (seeded), so two reverbs at the same decay
    // are the same data.
    const registered: string[] = []
    return {
      input,
      output: out,
      analysis,
      apply(p, when) {
        const decay = p.decay ?? 1.8
        // Regenerate the impulse only when decay actually changes.
        if (Math.abs(decay - impulseDecay) > 0.05) {
          impulseDecay = decay
          const sampleRate = backend.start().sampleRate
          const bufferId = impulseBufferId(decay, sampleRate)
          if (!backend.hasBuffer(bufferId)) {
            backend.registerBuffer(bufferId, makeImpulse(sampleRate, decay), sampleRate)
            registered.push(bufferId)
          }
          backend.configureNode(convolver, { buffer: bufferId })
        }
        const mix = p.mix ?? 0.25
        smooth(backend, wet, 'gain', mix, when)
        smooth(backend, dry, 'gain', 1 - mix * 0.5, when)
      },
      dispose() {
        for (const id of [input, mixed, dry, wet, convolver, out]) backend.disposeNode(id)
        for (const bufferId of registered) backend.releaseBuffer(bufferId)
        disposeTap()
      }
    }
  },

  lowpass: basicFilter('lowpass', 2000),
  highpass: basicFilter('highpass', 200),
  bandpass: basicFilter('bandpass', 1000),
  notch: basicFilter('notch', 1000),

  lfo(backend) {
    // Amplitude LFO (tremolo): an oscillator drives the carrier gain's
    // param through the seam's modulation edge. Base gain sits at
    // 1 - depth/2 and the oscillator swings ±depth/2 around it, so the
    // level sweeps [1-depth, 1] and never goes negative (a phase flip
    // would sound like ring modulation).
    const carrier = backend.createNode('gain')
    const depthGain = backend.createNode('gain')
    setNow(backend, depthGain, 'gain', 0)
    const osc = backend.createNode('oscillator', { type: 'sine' })
    setNow(backend, osc, 'frequency', 4)
    let currentWave = 'sine'
    // Free-running from now, no end: the same call a synth note uses.
    backend.scheduleSource(osc, 0)
    backend.connect(osc, depthGain)
    backend.connectParam(depthGain, carrier, 'gain')
    const { out, analysis, disposeTap } = tapOut(backend, carrier)
    return {
      input: carrier,
      output: out,
      analysis,
      apply(p, when) {
        smooth(backend, osc, 'frequency', p.rate ?? 4, when)
        const waveIndex = Math.max(
          0,
          Math.min(LFO_WAVE_TYPES.length - 1, Math.round(p.wave ?? 0))
        )
        const wave = LFO_WAVE_TYPES[waveIndex]
        if (currentWave !== wave) {
          currentWave = wave
          backend.configureNode(osc, { type: wave }) // not a param; instant
        }
        const depth = Math.max(0, Math.min(1, p.depth ?? 0.5))
        smooth(backend, carrier, 'gain', 1 - depth / 2, when)
        smooth(backend, depthGain, 'gain', depth / 2, when)
      },
      dispose() {
        backend.disconnectParam(depthGain, carrier, 'gain')
        for (const id of [osc, depthGain, carrier, out]) backend.disposeNode(id)
        disposeTap()
      }
    }
  }
}

export function builtinEffectProviders(): PluginProvider[] {
  return EFFECT_TYPES.map((type) => ({
    descriptor: builtinEffectDescriptor(type),
    create: BUILDERS[type]
  }))
}

