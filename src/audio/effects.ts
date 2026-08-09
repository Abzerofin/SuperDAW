import type { EffectType } from '@core/model/effects'
import { EFFECT_TYPES, PARAEQ_BANDS, PARAEQ_FILTER_TYPES } from '@core/model/effects'
import { builtinEffectDescriptor } from '@core/plugins/builtin'
import type { PluginNodes, PluginProvider } from './pluginRegistry'

/**
 * Web Audio node builders for the builtin insert effects, exposed as
 * PluginProviders. Each builder returns an input/output pair plus `apply`
 * to push param values into live AudioParams (smoothed — knob drags must
 * not zipper) and `dispose` for teardown.
 */

const SMOOTH = 0.02

const dbToGain = (db: number): number => Math.pow(10, db / 20)

/**
 * A spectrum/level tap that survives the engine's rewiring: the engine
 * calls `output.disconnect()` on every chain rewire, severing ALL of the
 * output node's connections — so the analyser must hang off an internal
 * node, behind a dedicated pass-through output gain.
 */
function tap(
  ctx: BaseAudioContext,
  from: AudioNode,
  fftSize = 2048
): { out: GainNode; analyser: AnalyserNode } {
  const out = ctx.createGain()
  const analyser = ctx.createAnalyser()
  analyser.fftSize = fftSize
  analyser.smoothingTimeConstant = 0.8
  from.connect(out)
  from.connect(analyser)
  return { out, analyser }
}

const BUILDERS: Record<EffectType, (ctx: BaseAudioContext) => PluginNodes> = {
  paraeq(ctx) {
    // One biquad per band slot, chained. Disabled slots are parked as
    // zero-gain peaking filters — audibly transparent — so the chain
    // never needs rewiring when bands are placed or removed.
    const filters: BiquadFilterNode[] = []
    for (let i = 0; i < PARAEQ_BANDS; i++) {
      const f = ctx.createBiquadFilter()
      f.type = 'peaking'
      f.gain.value = 0
      if (i > 0) filters[i - 1].connect(f)
      filters.push(f)
    }
    // Spectrum tap behind a pass-through output (see tap()).
    const { out, analyser } = tap(ctx, filters[filters.length - 1])
    return {
      input: filters[0],
      output: out,
      analysis: { spectrum: analyser },
      apply(p, when) {
        filters.forEach((f, i) => {
          const n = i + 1
          const on = (p[`b${n}on`] ?? 0) >= 0.5
          const typeIndex = Math.max(
            0,
            Math.min(PARAEQ_FILTER_TYPES.length - 1, Math.round(p[`b${n}type`] ?? 0))
          )
          const type = on ? PARAEQ_FILTER_TYPES[typeIndex] : 'peaking'
          if (f.type !== type) f.type = type // not an AudioParam; switches are instant
          f.frequency.setTargetAtTime(p[`b${n}freq`] ?? 1000, when, SMOOTH)
          f.gain.setTargetAtTime(on ? (p[`b${n}gain`] ?? 0) : 0, when, SMOOTH)
          // Web Audio interprets Q in dB for lowpass/highpass; our param is
          // the linear RBJ Q, so convert to keep the drawn curve honest.
          const q = p[`b${n}q`] ?? 1
          const nodeQ = type === 'lowpass' || type === 'highpass' ? 20 * Math.log10(q) : q
          f.Q.setTargetAtTime(nodeQ, when, SMOOTH)
        })
      },
      dispose() {
        for (const f of filters) f.disconnect()
        out.disconnect()
        analyser.disconnect()
      }
    }
  },

  eq3(ctx) {
    const low = ctx.createBiquadFilter()
    low.type = 'lowshelf'
    low.frequency.value = 200
    const mid = ctx.createBiquadFilter()
    mid.type = 'peaking'
    mid.Q.value = 0.9
    const high = ctx.createBiquadFilter()
    high.type = 'highshelf'
    high.frequency.value = 4000
    low.connect(mid)
    mid.connect(high)
    // Spectrum tap behind a pass-through output (see tap()).
    const { out, analyser } = tap(ctx, high)
    return {
      input: low,
      output: out,
      analysis: { spectrum: analyser },
      apply(p, when) {
        low.gain.setTargetAtTime(p.low ?? 0, when, SMOOTH)
        mid.gain.setTargetAtTime(p.mid ?? 0, when, SMOOTH)
        mid.frequency.setTargetAtTime(p.midFreq ?? 1000, when, SMOOTH)
        high.gain.setTargetAtTime(p.high ?? 0, when, SMOOTH)
      },
      dispose() {
        low.disconnect()
        mid.disconnect()
        high.disconnect()
        out.disconnect()
        analyser.disconnect()
      }
    }
  },

  compressor(ctx) {
    // Input gain (unity) exists so the card can watch the PRE-compression
    // level — the dot riding the transfer curve. Internal connections
    // survive rewires; only `input`'s inbound and `output`'s outbound
    // edges are engine-managed.
    const inGain = ctx.createGain()
    const inTap = ctx.createAnalyser()
    inTap.fftSize = 1024
    const comp = ctx.createDynamicsCompressor()
    comp.knee.value = 12
    const makeup = ctx.createGain()
    inGain.connect(inTap)
    inGain.connect(comp)
    comp.connect(makeup)
    const { out, analyser } = tap(ctx, makeup)
    return {
      input: inGain,
      output: out,
      analysis: { spectrum: analyser, input: inTap, reductionDb: () => comp.reduction },
      apply(p, when) {
        comp.threshold.setTargetAtTime(p.threshold ?? -24, when, SMOOTH)
        comp.ratio.setTargetAtTime(p.ratio ?? 4, when, SMOOTH)
        comp.attack.setTargetAtTime(p.attack ?? 0.01, when, SMOOTH)
        comp.release.setTargetAtTime(p.release ?? 0.25, when, SMOOTH)
        makeup.gain.setTargetAtTime(dbToGain(p.makeup ?? 0), when, SMOOTH)
      },
      dispose() {
        for (const node of [inGain, inTap, comp, makeup, out, analyser]) node.disconnect()
      }
    }
  },

  limiter(ctx) {
    // A hard-kneed, fast, high-ratio compressor — the standard native-node
    // brickwall approximation.
    const inGain = ctx.createGain()
    const inTap = ctx.createAnalyser()
    inTap.fftSize = 1024
    const comp = ctx.createDynamicsCompressor()
    comp.knee.value = 0
    comp.ratio.value = 20
    comp.attack.value = 0.002
    inGain.connect(inTap)
    inGain.connect(comp)
    const { out, analyser } = tap(ctx, comp)
    return {
      input: inGain,
      output: out,
      analysis: { spectrum: analyser, input: inTap, reductionDb: () => comp.reduction },
      apply(p, when) {
        comp.threshold.setTargetAtTime(p.ceiling ?? -1, when, SMOOTH)
        comp.release.setTargetAtTime(p.release ?? 0.1, when, SMOOTH)
      },
      dispose() {
        for (const node of [inGain, inTap, comp, out, analyser]) node.disconnect()
      }
    }
  },

  delay(ctx) {
    const input = ctx.createGain()
    const mixed = ctx.createGain()
    const dry = ctx.createGain()
    const wet = ctx.createGain()
    const delay = ctx.createDelay(2)
    const feedback = ctx.createGain()
    input.connect(dry)
    dry.connect(mixed)
    input.connect(delay)
    delay.connect(wet)
    wet.connect(mixed)
    delay.connect(feedback)
    feedback.connect(delay)
    const { out, analyser } = tap(ctx, mixed)
    return {
      input,
      output: out,
      analysis: { spectrum: analyser },
      apply(p, when) {
        delay.delayTime.setTargetAtTime(p.time ?? 0.3, when, SMOOTH)
        feedback.gain.setTargetAtTime(p.feedback ?? 0.35, when, SMOOTH)
        const mix = p.mix ?? 0.25
        wet.gain.setTargetAtTime(mix, when, SMOOTH)
        dry.gain.setTargetAtTime(1 - mix * 0.5, when, SMOOTH)
      },
      dispose() {
        for (const node of [input, mixed, out, analyser, dry, wet, delay, feedback]) {
          node.disconnect()
        }
      }
    }
  },

  reverb(ctx) {
    const input = ctx.createGain()
    const mixed = ctx.createGain()
    const dry = ctx.createGain()
    const wet = ctx.createGain()
    const convolver = ctx.createConvolver()
    let impulseDecay = -1
    input.connect(dry)
    dry.connect(mixed)
    input.connect(convolver)
    convolver.connect(wet)
    wet.connect(mixed)
    const { out, analyser } = tap(ctx, mixed)
    return {
      input,
      output: out,
      analysis: { spectrum: analyser },
      apply(p, when) {
        const decay = p.decay ?? 1.8
        // Regenerate the impulse only when decay actually changes.
        if (Math.abs(decay - impulseDecay) > 0.05) {
          impulseDecay = decay
          convolver.buffer = makeImpulse(ctx, decay)
        }
        const mix = p.mix ?? 0.25
        wet.gain.setTargetAtTime(mix, when, SMOOTH)
        dry.gain.setTargetAtTime(1 - mix * 0.5, when, SMOOTH)
      },
      dispose() {
        for (const node of [input, mixed, out, analyser, dry, wet, convolver]) node.disconnect()
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

/** Stereo exponentially-decaying noise impulse. */
function makeImpulse(ctx: BaseAudioContext, decaySeconds: number): AudioBuffer {
  const length = Math.max(1, Math.round(ctx.sampleRate * decaySeconds))
  const buffer = ctx.createBuffer(2, length, ctx.sampleRate)
  for (let ch = 0; ch < 2; ch++) {
    const data = buffer.getChannelData(ch)
    for (let i = 0; i < length; i++) {
      data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / length, 2.5)
    }
  }
  return buffer
}
