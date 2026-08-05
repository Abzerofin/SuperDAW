/**
 * Effect and instrument parameter metadata — part of the domain model so
 * the reducer can clamp values, the engine can build nodes, and the UI can
 * render controls from one source of truth. Pure data, no audio imports.
 */

export type EffectType = 'eq3' | 'compressor' | 'limiter' | 'delay' | 'reverb'

export interface ParamDef {
  readonly label: string
  readonly min: number
  readonly max: number
  readonly default: number
  /** Display unit; '' = plain number. */
  readonly unit: string
  /** Decimal places for display. */
  readonly digits: number
}

export interface EffectDef {
  readonly label: string
  readonly params: Readonly<Record<string, ParamDef>>
}

const p = (
  label: string,
  min: number,
  max: number,
  def: number,
  unit = '',
  digits = 1
): ParamDef => ({ label, min, max, default: def, unit, digits })

export const EFFECT_DEFS: Readonly<Record<EffectType, EffectDef>> = {
  eq3: {
    label: 'EQ',
    params: {
      low: p('Low', -12, 12, 0, 'dB'),
      mid: p('Mid', -12, 12, 0, 'dB'),
      midFreq: p('Mid Freq', 200, 5000, 1000, 'Hz', 0),
      high: p('High', -12, 12, 0, 'dB')
    }
  },
  compressor: {
    label: 'Compressor',
    params: {
      threshold: p('Threshold', -60, 0, -24, 'dB'),
      ratio: p('Ratio', 1, 20, 4, ':1'),
      attack: p('Attack', 0.001, 0.3, 0.01, 's', 3),
      release: p('Release', 0.05, 1, 0.25, 's', 2),
      makeup: p('Makeup', 0, 24, 0, 'dB')
    }
  },
  limiter: {
    label: 'Limiter',
    params: {
      ceiling: p('Ceiling', -24, 0, -1, 'dB'),
      release: p('Release', 0.05, 1, 0.1, 's', 2)
    }
  },
  delay: {
    label: 'Delay',
    params: {
      time: p('Time', 0.02, 1.5, 0.3, 's', 2),
      feedback: p('Feedback', 0, 0.9, 0.35, '', 2),
      mix: p('Mix', 0, 1, 0.25, '', 2)
    }
  },
  reverb: {
    label: 'Reverb',
    params: {
      decay: p('Decay', 0.2, 8, 1.8, 's', 1),
      mix: p('Mix', 0, 1, 0.25, '', 2)
    }
  }
}

export const EFFECT_TYPES = Object.keys(EFFECT_DEFS) as EffectType[]

/** Built-in synth parameters (per MIDI track). wave indexes WAVE_TYPES. */
export const WAVE_TYPES = ['sawtooth', 'square', 'triangle', 'sine'] as const

export const SYNTH_DEFS: Readonly<Record<string, ParamDef>> = {
  wave: p('Wave', 0, WAVE_TYPES.length - 1, 0, '', 0),
  cutoff: p('Cutoff', 0.5, 16, 7, '×', 1),
  attack: p('Attack', 0.001, 1, 0.006, 's', 3),
  decay: p('Decay', 0.01, 1.5, 0.09, 's', 2),
  sustain: p('Sustain', 0, 1, 0.65, '', 2),
  release: p('Release', 0.01, 2, 0.07, 's', 2),
  detune: p('Detune', 0, 30, 4, 'ct', 0)
}

export function synthDefaults(): Record<string, number> {
  return Object.fromEntries(Object.entries(SYNTH_DEFS).map(([k, def]) => [k, def.default]))
}

export function effectDefaults(type: EffectType): Record<string, number> {
  return Object.fromEntries(
    Object.entries(EFFECT_DEFS[type].params).map(([k, def]) => [k, def.default])
  )
}

export function clampParam(def: ParamDef | undefined, value: number): number {
  if (!def || !Number.isFinite(value)) return def?.default ?? 0
  return Math.min(def.max, Math.max(def.min, value))
}
