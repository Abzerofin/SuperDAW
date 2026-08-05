import type { EffectType } from '@core/model/effects'
import { EFFECT_TYPES } from '@core/model/effects'
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

const BUILDERS: Record<EffectType, (ctx: BaseAudioContext) => PluginNodes> = {
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
    return {
      input: low,
      output: high,
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
      }
    }
  },

  compressor(ctx) {
    const comp = ctx.createDynamicsCompressor()
    comp.knee.value = 12
    const makeup = ctx.createGain()
    comp.connect(makeup)
    return {
      input: comp,
      output: makeup,
      apply(p, when) {
        comp.threshold.setTargetAtTime(p.threshold ?? -24, when, SMOOTH)
        comp.ratio.setTargetAtTime(p.ratio ?? 4, when, SMOOTH)
        comp.attack.setTargetAtTime(p.attack ?? 0.01, when, SMOOTH)
        comp.release.setTargetAtTime(p.release ?? 0.25, when, SMOOTH)
        makeup.gain.setTargetAtTime(dbToGain(p.makeup ?? 0), when, SMOOTH)
      },
      dispose() {
        comp.disconnect()
        makeup.disconnect()
      }
    }
  },

  limiter(ctx) {
    // A hard-kneed, fast, high-ratio compressor — the standard native-node
    // brickwall approximation.
    const comp = ctx.createDynamicsCompressor()
    comp.knee.value = 0
    comp.ratio.value = 20
    comp.attack.value = 0.002
    return {
      input: comp,
      output: comp,
      apply(p, when) {
        comp.threshold.setTargetAtTime(p.ceiling ?? -1, when, SMOOTH)
        comp.release.setTargetAtTime(p.release ?? 0.1, when, SMOOTH)
      },
      dispose() {
        comp.disconnect()
      }
    }
  },

  delay(ctx) {
    const input = ctx.createGain()
    const output = ctx.createGain()
    const dry = ctx.createGain()
    const wet = ctx.createGain()
    const delay = ctx.createDelay(2)
    const feedback = ctx.createGain()
    input.connect(dry)
    dry.connect(output)
    input.connect(delay)
    delay.connect(wet)
    wet.connect(output)
    delay.connect(feedback)
    feedback.connect(delay)
    return {
      input,
      output,
      apply(p, when) {
        delay.delayTime.setTargetAtTime(p.time ?? 0.3, when, SMOOTH)
        feedback.gain.setTargetAtTime(p.feedback ?? 0.35, when, SMOOTH)
        const mix = p.mix ?? 0.25
        wet.gain.setTargetAtTime(mix, when, SMOOTH)
        dry.gain.setTargetAtTime(1 - mix * 0.5, when, SMOOTH)
      },
      dispose() {
        for (const node of [input, output, dry, wet, delay, feedback]) node.disconnect()
      }
    }
  },

  reverb(ctx) {
    const input = ctx.createGain()
    const output = ctx.createGain()
    const dry = ctx.createGain()
    const wet = ctx.createGain()
    const convolver = ctx.createConvolver()
    let impulseDecay = -1
    input.connect(dry)
    dry.connect(output)
    input.connect(convolver)
    convolver.connect(wet)
    wet.connect(output)
    return {
      input,
      output,
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
        for (const node of [input, output, dry, wet, convolver]) node.disconnect()
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
