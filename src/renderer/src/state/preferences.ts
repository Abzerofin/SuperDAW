import { useSyncExternalStore } from 'react'
import { appStorageGet, appStorageSet } from './appStorage'

/**
 * Small app-level preferences (Settings ▸ General / Collaboration).
 * App state, never document state — personal, persisted through the
 * appStorage seam, synced to no one.
 */

/** What a project-tempo change does to existing audio clips. */
export type TempoConformChoice = 'ask' | 'always' | 'never'

/**
 * The AudioContext latency request — the closest thing the platform gives
 * to a buffer-size knob. 'interactive' = smallest buffers (live monitoring
 * / recording), 'playback' = biggest (glitch-proof mixing on weak CPUs).
 * Applied when the audio engine starts; changing it mid-session takes
 * effect at the next launch (the context lives for the whole session).
 */
export type LatencyHintChoice = 'interactive' | 'balanced' | 'playback'

interface Preferences {
  /** Middle-CLICK sends a collaboration ping (drag always pans). */
  middleClickPing: boolean
  /** Fetch collaborators' assets automatically; off = ask first. */
  autoDownloadAssets: boolean
  /** Stretch audio clips to follow BPM changes: ask / always / never. */
  tempoConform: TempoConformChoice
  /** Metronome bars clicked before recording starts rolling (0 = off). */
  countInBars: 0 | 1 | 2
  /**
   * Extra milliseconds recorded takes are pulled EARLIER on the timeline,
   * on top of the automatic output-latency compensation — the knob for the
   * input path (interface buffers), which the platform does not report.
   */
  recordLatencyTrimMs: number
  /** Buffer-size request for the audio engine (see LatencyHintChoice). */
  latencyHint: LatencyHintChoice
  /** Seconds between crash-recovery snapshots while the project is dirty. */
  autosaveIntervalSec: number
  /** Whole-UI zoom factor (1 = 100%). Personal + per-machine by nature. */
  uiScale: number
}

/** The trim is a correction, not an offset tool — keep it in sane bounds. */
const LATENCY_TRIM_LIMIT_MS = 250

/** Autosave cadence bounds: often enough to matter, never often enough to hurt. */
const AUTOSAVE_MIN_SEC = 5
const AUTOSAVE_MAX_SEC = 300

/** UI zoom bounds — enough range for 4K and small laptops, never absurd. */
const UI_SCALE_MIN = 0.75
const UI_SCALE_MAX = 1.5

const DEFAULTS: Preferences = {
  middleClickPing: true,
  autoDownloadAssets: false,
  tempoConform: 'ask',
  countInBars: 1,
  recordLatencyTrimMs: 0,
  latencyHint: 'interactive',
  autosaveIntervalSec: 20,
  uiScale: 1
}

const STORAGE_KEY = 'preferences'

class PreferencesStore {
  private prefs: Preferences = { ...DEFAULTS }
  private version = 0
  private listeners = new Set<() => void>()

  constructor() {
    void this.init()
  }

  private async init(): Promise<void> {
    const stored = await appStorageGet<Partial<Preferences>>(STORAGE_KEY)
    if (!stored) return
    this.prefs = {
      middleClickPing:
        typeof stored.middleClickPing === 'boolean'
          ? stored.middleClickPing
          : DEFAULTS.middleClickPing,
      autoDownloadAssets:
        typeof stored.autoDownloadAssets === 'boolean'
          ? stored.autoDownloadAssets
          : DEFAULTS.autoDownloadAssets,
      tempoConform: ['ask', 'always', 'never'].includes(stored.tempoConform as string)
        ? (stored.tempoConform as TempoConformChoice)
        : DEFAULTS.tempoConform,
      countInBars: [0, 1, 2].includes(stored.countInBars as number)
        ? (stored.countInBars as 0 | 1 | 2)
        : DEFAULTS.countInBars,
      recordLatencyTrimMs:
        typeof stored.recordLatencyTrimMs === 'number' &&
        Number.isFinite(stored.recordLatencyTrimMs)
          ? Math.max(
              -LATENCY_TRIM_LIMIT_MS,
              Math.min(LATENCY_TRIM_LIMIT_MS, stored.recordLatencyTrimMs)
            )
          : DEFAULTS.recordLatencyTrimMs,
      latencyHint: ['interactive', 'balanced', 'playback'].includes(stored.latencyHint as string)
        ? (stored.latencyHint as LatencyHintChoice)
        : DEFAULTS.latencyHint,
      autosaveIntervalSec:
        typeof stored.autosaveIntervalSec === 'number' &&
        Number.isFinite(stored.autosaveIntervalSec)
          ? Math.max(
              AUTOSAVE_MIN_SEC,
              Math.min(AUTOSAVE_MAX_SEC, Math.round(stored.autosaveIntervalSec))
            )
          : DEFAULTS.autosaveIntervalSec,
      uiScale:
        typeof stored.uiScale === 'number' && Number.isFinite(stored.uiScale)
          ? Math.max(UI_SCALE_MIN, Math.min(UI_SCALE_MAX, stored.uiScale))
          : DEFAULTS.uiScale
    }
    this.applyUiScale()
    this.emit()
  }

  /**
   * The one preference with a DOM side effect: the whole UI scales via CSS
   * zoom on the root (Chromium-only CSS, which is all this app targets —
   * Electron and the browser dev build). Applied at load and on change,
   * like the theme's root attributes.
   */
  private applyUiScale(): void {
    if (typeof document === 'undefined') return
    const scale = this.prefs.uiScale
    document.documentElement.style.setProperty('zoom', scale === 1 ? '' : String(scale))
  }

  get middleClickPing(): boolean {
    return this.prefs.middleClickPing
  }

  get autoDownloadAssets(): boolean {
    return this.prefs.autoDownloadAssets
  }

  get tempoConform(): TempoConformChoice {
    return this.prefs.tempoConform
  }

  get countInBars(): 0 | 1 | 2 {
    return this.prefs.countInBars
  }

  get recordLatencyTrimMs(): number {
    return this.prefs.recordLatencyTrimMs
  }

  get latencyHint(): LatencyHintChoice {
    return this.prefs.latencyHint
  }

  get autosaveIntervalSec(): number {
    return this.prefs.autosaveIntervalSec
  }

  get uiScale(): number {
    return this.prefs.uiScale
  }

  set<K extends keyof Preferences>(key: K, value: Preferences[K]): void {
    if (this.prefs[key] === value) return
    this.prefs = { ...this.prefs, [key]: value }
    void appStorageSet(STORAGE_KEY, this.prefs)
    if (key === 'uiScale') this.applyUiScale()
    this.emit()
  }

  getVersion = (): number => this.version

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private emit(): void {
    this.version++
    for (const listener of this.listeners) listener()
  }
}

export const preferences = new PreferencesStore()

export function usePreferences(): number {
  return useSyncExternalStore(preferences.subscribe, preferences.getVersion)
}
