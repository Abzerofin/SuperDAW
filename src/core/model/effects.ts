/**
 * Effect and instrument parameter metadata — part of the domain model so
 * the reducer can clamp values, the engine can build nodes, and the UI can
 * render controls from one source of truth. Pure data, no audio imports.
 */

export type EffectType =
  | 'paraeq'
  | 'eq3'
  | 'compressor'
  | 'limiter'
  | 'delay'
  | 'reverb'
  | 'reverbpro'
  | 'saturator'
  | 'lowpass'
  | 'highpass'
  | 'bandpass'
  | 'notch'
  | 'lfo'

/** LFO waveforms, indexed by the `wave` param value. */
export const LFO_WAVE_TYPES = ['sine', 'triangle', 'square', 'sawtooth'] as const

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

/**
 * Parametric EQ: a fixed pool of band slots, each a flat set of numeric
 * params (the plugin param model is Record<string, number>). Bands are
 * "placed" by enabling a slot; disabled slots are audibly transparent.
 */
export const PARAEQ_BANDS = 8

/** Band filter shapes, indexed by the b{i}type param value. */
export const PARAEQ_FILTER_TYPES = [
  'peaking',
  'lowshelf',
  'highshelf',
  'highpass',
  'lowpass',
  'notch'
] as const

/** Four flat default bands (like a hardware channel EQ); four spare slots. */
const PARAEQ_BAND_DEFAULTS = [
  { on: 1, type: 1, freq: 100 },
  { on: 1, type: 0, freq: 600 },
  { on: 1, type: 0, freq: 2500 },
  { on: 1, type: 2, freq: 8000 },
  { on: 0, type: 0, freq: 200 },
  { on: 0, type: 0, freq: 1200 },
  { on: 0, type: 0, freq: 5000 },
  { on: 0, type: 0, freq: 12000 }
] as const

function paraeqParams(): Record<string, ParamDef> {
  const params: Record<string, ParamDef> = {}
  PARAEQ_BAND_DEFAULTS.forEach((band, i) => {
    const n = i + 1
    params[`b${n}on`] = p(`B${n} On`, 0, 1, band.on, '', 0)
    params[`b${n}type`] = p(`B${n} Type`, 0, PARAEQ_FILTER_TYPES.length - 1, band.type, '', 0)
    params[`b${n}freq`] = p(`B${n} Freq`, 20, 20000, band.freq, 'Hz', 0)
    params[`b${n}gain`] = p(`B${n} Gain`, -18, 18, 0, 'dB', 1)
    params[`b${n}q`] = p(`B${n} Q`, 0.1, 12, 1, '', 2)
  })
  return params
}

export const EFFECT_DEFS: Readonly<Record<EffectType, EffectDef>> = {
  paraeq: {
    label: 'EQ',
    params: paraeqParams()
  },
  eq3: {
    label: 'EQ (3-band)',
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
  },
  reverbpro: {
    label: 'Reverb Pro',
    params: {
      decay: p('Decay', 0.2, 10, 2.4, 's', 1),
      predelay: p('Pre-delay', 0, 200, 20, 'ms', 0),
      damping: p('Damping', 0, 1, 0.5, '', 2),
      size: p('Size', 0, 1, 0.7, '', 2),
      width: p('Width', 0, 1, 1, '', 2),
      mix: p('Mix', 0, 1, 0.3, '', 2)
    }
  },
  saturator: {
    label: 'Saturator',
    params: {
      drive: p('Drive', 0, 36, 6, 'dB', 1),
      tone: p('Tone', 0, 1, 0.5, '', 2),
      mix: p('Mix', 0, 1, 1, '', 2),
      trim: p('Trim', -24, 12, 0, 'dB', 1)
    }
  },
  lowpass: {
    label: 'Low-pass Filter',
    params: {
      cutoff: p('Cutoff', 20, 20000, 2000, 'Hz', 0),
      resonance: p('Resonance', 0.1, 12, 0.71, '', 2)
    }
  },
  highpass: {
    label: 'High-pass Filter',
    params: {
      cutoff: p('Cutoff', 20, 20000, 200, 'Hz', 0),
      resonance: p('Resonance', 0.1, 12, 0.71, '', 2)
    }
  },
  bandpass: {
    label: 'Band-pass Filter',
    params: {
      cutoff: p('Cutoff', 20, 20000, 1000, 'Hz', 0),
      resonance: p('Resonance', 0.1, 12, 1, '', 2)
    }
  },
  notch: {
    label: 'Notch Filter',
    params: {
      cutoff: p('Cutoff', 20, 20000, 1000, 'Hz', 0),
      resonance: p('Resonance', 0.1, 12, 1, '', 2)
    }
  },
  lfo: {
    label: 'LFO',
    params: {
      rate: p('Rate', 0.05, 20, 4, 'Hz', 2),
      depth: p('Depth', 0, 1, 0.5, '', 2),
      wave: p('Wave', 0, LFO_WAVE_TYPES.length - 1, 0, '', 0)
    }
  }
}

export const EFFECT_TYPES = Object.keys(EFFECT_DEFS) as EffectType[]

/** Built-in synth parameters (per MIDI track). wave indexes WAVE_TYPES. */
export const WAVE_TYPES = ['sawtooth', 'square', 'triangle', 'sine'] as const

/**
 * Synth params that are STATE, not sound: whether the instrument exists on
 * the track at all (`present`) and whether it is bypassed (`on`). Both live
 * here as plain numbers so they flow through the existing
 * `track/setSynthParam` op — no model change, no new op, invert for free.
 * The UI hides them from the slider list; `synthIsAudible` is the one
 * place that reads them.
 */
export const SYNTH_STATE_PARAMS = ['present', 'on'] as const

/**
 * Which built-in instrument a MIDI track's `synth` record drives, selected
 * by the `instrument` param (an index into this list — a plain number so
 * switching instruments flows through the existing synth-param ops).
 * Every instrument's params coexist in the one flat record; only the
 * active instrument's are audible, so switching back and forth never
 * loses a knob position.
 */
export const INSTRUMENT_KINDS = ['analog', 'sampler', 'drums'] as const
export type InstrumentKind = (typeof INSTRUMENT_KINDS)[number]

export function instrumentKindOf(synth: Readonly<Record<string, number>>): InstrumentKind {
  return INSTRUMENT_KINDS[Math.round(synth.instrument ?? 0)] ?? 'analog'
}

/** The `instrument` value a drum track starts on (see TrackKind 'drum'). */
export const DRUM_INSTRUMENT_INDEX = INSTRUMENT_KINDS.indexOf('drums')

/**
 * Sliced-sampler keyboard mapping: slice 0 plays on this MIDI pitch,
 * slice N on SLICE_BASE_PITCH + N (capped at MAX_SLICES). Shared by the
 * audio voice builders, the slice-to-sampler op builder and the UI so a
 * chopped break triggers identically everywhere.
 */
export const SLICE_BASE_PITCH = 36
export const MAX_SLICES = 64

/**
 * The drum synth's pad roster: eight synthesized voices on the standard
 * GM drum pitches (aliases catch the neighbouring GM assignments so
 * imported grooves land on the right pads). Each pad owns four params in
 * the synth record — `<key>Tune`/`<key>Decay`/`<key>Tone`/`<key>Level` —
 * generated below so the reducer clamps them like any synth param.
 */
export interface DrumPadDef {
  /** Param prefix in the synth record, e.g. 'kick' → kickTune. */
  readonly key: string
  readonly label: string
  /** Canonical MIDI pitch (GM drum map). */
  readonly pitch: number
  readonly aliases: readonly number[]
}

export const DRUM_PADS: readonly DrumPadDef[] = [
  { key: 'kick', label: 'Kick', pitch: 36, aliases: [35] },
  { key: 'snare', label: 'Snare', pitch: 38, aliases: [40] },
  { key: 'clap', label: 'Clap', pitch: 39, aliases: [] },
  { key: 'hatc', label: 'Hat', pitch: 42, aliases: [44] },
  { key: 'hato', label: 'Open Hat', pitch: 46, aliases: [] },
  { key: 'toml', label: 'Lo Tom', pitch: 43, aliases: [41, 45] },
  { key: 'tomh', label: 'Hi Tom', pitch: 50, aliases: [47, 48] },
  { key: 'ride', label: 'Ride', pitch: 51, aliases: [49, 53, 57] }
] as const

/** The pad a MIDI pitch triggers on the drum synth; null = unmapped (silent). */
export function drumPadForPitch(pitch: number): DrumPadDef | null {
  const rounded = Math.round(pitch)
  for (const pad of DRUM_PADS) {
    if (pad.pitch === rounded || pad.aliases.includes(rounded)) return pad
  }
  return null
}

function drumParams(): Record<string, ParamDef> {
  const params: Record<string, ParamDef> = {}
  for (const pad of DRUM_PADS) {
    params[`${pad.key}Tune`] = p(`${pad.label} Tune`, -12, 12, 0, 'st', 0)
    params[`${pad.key}Decay`] = p(`${pad.label} Decay`, 0.25, 4, 1, '×', 2)
    params[`${pad.key}Tone`] = p(`${pad.label} Tone`, 0, 1, 0.5, '', 2)
    params[`${pad.key}Level`] = p(`${pad.label} Level`, 0, 1.5, 1, '', 2)
  }
  return params
}

export const SYNTH_DEFS: Readonly<Record<string, ParamDef>> = {
  present: p('Present', 0, 1, 1, '', 0),
  on: p('On', 0, 1, 1, '', 0),
  instrument: p('Instrument', 0, INSTRUMENT_KINDS.length - 1, 0, '', 0),
  wave: p('Wave', 0, WAVE_TYPES.length - 1, 0, '', 0),
  cutoff: p('Cutoff', 0.5, 16, 7, '×', 1),
  attack: p('Attack', 0.001, 1, 0.006, 's', 3),
  decay: p('Decay', 0.01, 1.5, 0.09, 's', 2),
  sustain: p('Sustain', 0, 1, 0.65, '', 2),
  release: p('Release', 0.01, 2, 0.07, 's', 2),
  detune: p('Detune', 0, 30, 4, 'ct', 0),
  // Sampler (the asset it plays lives on Track.samplerAssetId).
  smpRoot: p('Root Note', 0, 127, 60, '', 0),
  /** 0 = keys (chromatic from the root), 1 = slices (transient chops). */
  smpMode: p('Mode', 0, 1, 0, '', 0),
  smpStart: p('Start', 0, 1, 0, '', 2),
  smpEnd: p('End', 0, 1, 1, '', 2),
  smpLoop: p('Loop', 0, 1, 0, '', 0),
  smpAttack: p('Attack', 0.001, 1, 0.003, 's', 3),
  smpDecay: p('Decay', 0.01, 2, 0.2, 's', 2),
  smpSustain: p('Sustain', 0, 1, 1, '', 2),
  smpRelease: p('Release', 0.005, 3, 0.08, 's', 2),
  smpGain: p('Gain', 0, 2, 1, '', 2),
  // Drum synth: four params per pad, generated from DRUM_PADS.
  ...drumParams()
}

/**
 * Does this track's built-in synth make sound? Removed or bypassed both
 * mean silence. Params default to present+on, so projects saved before
 * these flags existed keep sounding exactly as they did.
 */
export function synthIsAudible(synth: Readonly<Record<string, number>>): boolean {
  return (synth.present ?? 1) >= 0.5 && (synth.on ?? 1) >= 0.5
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
  if (!def || !Number.isFinite(value)) {
    const fallback = def?.default
    return typeof fallback === 'number' && Number.isFinite(fallback) ? fallback : 0
  }
  const clamped = Math.min(def.max, Math.max(def.min, value))
  // A junk def (non-numeric min/max that slipped past validation) must
  // never emit NaN — clamp output lands in the synced document.
  return Number.isFinite(clamped) ? clamped : value
}

/** Normalized 0..1 ↦ the param's real range (automation curve values). */
export function denormalizeParam(def: ParamDef, v: number): number {
  return def.min + Math.min(1, Math.max(0, v)) * (def.max - def.min)
}

/** The param's real range ↦ normalized 0..1. */
export function normalizeParam(def: ParamDef, value: number): number {
  return def.max === def.min ? 0 : (clampParam(def, value) - def.min) / (def.max - def.min)
}
