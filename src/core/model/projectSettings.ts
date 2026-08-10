import { PPQ } from './timebase'

/**
 * Project-scoped settings: mix/workflow decisions every collaborator shares
 * (a loudness target or a default fade is a property of the SONG, not of any
 * one machine). They live in the document (`ProjectState.settings`), are
 * saved in .sdaw files, and change only through the `project/updateSettings`
 * operation — a patch of ABSOLUTE per-field values, so re-delivery is
 * idempotent and concurrent edits from two peers resolve per field by
 * last-write-wins, exactly like every other one-gesture-one-op field.
 *
 * Personal or machine-local facts (audio devices, theme, autosave cadence,
 * latency hint, count-in) deliberately stay OUT of this type — they live in
 * renderer appStorage (`state/preferences.ts` etc.) and sync to no one.
 *
 * Every field is normalized deterministically (`normalizeProjectSettings`)
 * so the reducer clamps identically on every peer regardless of who sent
 * the op — the same rule plugin params follow.
 */

/** Snap-grid resolutions (shared with the renderer's grid selector). */
export type SnapChoice = 'auto' | 'bar' | 'beat' | '1/8' | '1/16' | 'off'

const SNAP_CHOICES: readonly SnapChoice[] = ['auto', 'bar', 'beat', '1/8', '1/16', 'off']

export type ProjectExportFormat = 'wav' | 'mp3'

/** WAV word length for renders. MP3 encodes from float and ignores this. */
export type ProjectExportBitDepth = 16 | 24

export interface ProjectSettings {
  /**
   * Integrated-loudness mix target in LUFS, or null = no target. Stored so
   * the whole session mixes toward one number; metering against it is a
   * per-client runtime concern (like plugin availability).
   */
  readonly loudnessTargetLufs: number | null
  /**
   * Default fade in/out (ticks) stamped on newly imported audio clips —
   * the classic anti-click micro-fade. 0 = off. Existing clips are never
   * touched; this only seeds `clip/create`.
   */
  readonly defaultFadeTicks: number
  /**
   * Swing applied by quantize: 0 = straight; N delays every off-beat grid
   * position by N% of half a grid step (≈66 gives a triplet feel).
   */
  readonly swingPercent: number
  /** Quantize strength: 1 = full snap, 0.5 = move halfway to the grid. */
  readonly quantizeStrength: number
  /** Humanize jitter bound in ticks (± this much per note). */
  readonly humanizeTicks: number
  /**
   * The project's default snap grid. Seeds each user's (ephemeral) grid
   * choice when the project loads; live grid switching stays per-user.
   */
  readonly defaultGrid: SnapChoice
  /** Default audio export format for this project's renders. */
  readonly exportFormat: ProjectExportFormat
  /** WAV bit depth for this project's renders (MP3 ignores it). */
  readonly exportBitDepth: ProjectExportBitDepth
}

export const DEFAULT_PROJECT_SETTINGS: ProjectSettings = {
  loudnessTargetLufs: null,
  defaultFadeTicks: 0,
  swingPercent: 0,
  quantizeStrength: 1,
  humanizeTicks: PPQ / 32,
  defaultGrid: 'auto',
  exportFormat: 'wav',
  exportBitDepth: 16
}

/** One-click loudness targets for the platforms producers master for. */
export interface LoudnessPreset {
  readonly label: string
  readonly lufs: number
}

export const LOUDNESS_PRESETS: readonly LoudnessPreset[] = [
  { label: 'Streaming — Spotify / YouTube', lufs: -14 },
  { label: 'Apple Music', lufs: -16 },
  { label: 'Broadcast — EBU R128', lufs: -23 }
]

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/**
 * Per-field normalizers — pure, deterministic, shared by the reducer and
 * the file loader so a peer-sent patch and a decade-old file sanitize to
 * the exact same values.
 */
const NORMALIZERS: {
  [K in keyof ProjectSettings]: (raw: unknown) => ProjectSettings[K] | undefined
} = {
  loudnessTargetLufs: (raw) => {
    if (raw === null) return null
    if (typeof raw !== 'number' || !Number.isFinite(raw)) return undefined
    return Math.round(clamp(raw, -36, 0) * 10) / 10
  },
  defaultFadeTicks: (raw) => {
    if (typeof raw !== 'number' || !Number.isFinite(raw)) return undefined
    return Math.round(clamp(raw, 0, PPQ * 4))
  },
  swingPercent: (raw) => {
    if (typeof raw !== 'number' || !Number.isFinite(raw)) return undefined
    return Math.round(clamp(raw, 0, 100))
  },
  quantizeStrength: (raw) => {
    if (typeof raw !== 'number' || !Number.isFinite(raw)) return undefined
    return Math.round(clamp(raw, 0, 1) * 100) / 100
  },
  humanizeTicks: (raw) => {
    if (typeof raw !== 'number' || !Number.isFinite(raw)) return undefined
    return Math.round(clamp(raw, 1, PPQ))
  },
  defaultGrid: (raw) =>
    SNAP_CHOICES.includes(raw as SnapChoice) ? (raw as SnapChoice) : undefined,
  exportFormat: (raw) => (raw === 'wav' || raw === 'mp3' ? raw : undefined),
  exportBitDepth: (raw) => (raw === 16 || raw === 24 ? raw : undefined)
}

const SETTINGS_KEYS = Object.keys(NORMALIZERS) as Array<keyof ProjectSettings>

/**
 * Sanitize a settings patch: unknown keys are dropped, known keys keep only
 * values their normalizer accepts. The result is safe to merge on any peer.
 */
export function sanitizeSettingsPatch(raw: unknown): Partial<ProjectSettings> {
  const patch: Record<string, unknown> = {}
  if (typeof raw !== 'object' || raw === null) return patch as Partial<ProjectSettings>
  const candidate = raw as Record<string, unknown>
  for (const key of SETTINGS_KEYS) {
    if (!(key in candidate)) continue
    const value = NORMALIZERS[key](candidate[key])
    if (value !== undefined) patch[key] = value
  }
  return patch as Partial<ProjectSettings>
}

/**
 * Normalize a whole settings object (file load, migration): every field
 * present and valid or replaced by its default.
 */
export function normalizeProjectSettings(raw: unknown): ProjectSettings {
  return { ...DEFAULT_PROJECT_SETTINGS, ...sanitizeSettingsPatch(raw) }
}

/**
 * Merge an (already sanitized) patch into current settings. Returns the
 * SAME reference when nothing changes, so `apply` detects no-ops by
 * identity like everywhere else.
 */
export function mergeSettings(
  current: ProjectSettings,
  patch: Partial<ProjectSettings>
): ProjectSettings {
  let changed = false
  for (const key of SETTINGS_KEYS) {
    if (key in patch && patch[key] !== current[key]) {
      changed = true
      break
    }
  }
  return changed ? { ...current, ...patch } : current
}

/** The keys a patch actually touches (post-sanitize), for invert/describe. */
export function patchKeys(patch: Partial<ProjectSettings>): Array<keyof ProjectSettings> {
  return SETTINGS_KEYS.filter((key) => key in patch)
}
