import { useSyncExternalStore } from 'react'
import {
  MAX_LAG_SEC,
  MAX_SPREAD_SEC,
  MIN_CONFIDENCE,
  REPEAT_COUNT,
  summarizeMeasurements
} from '@audio/calibration'
import { measureLoopbackOnce } from '@audio/calibrationRun'
import { appStorageGet, appStorageSet } from './appStorage'
import { audioEngine } from './audioInstance'
import { audioDevices } from './audioDevices'
import { trackInputs } from './trackInputs'
import { preferences } from './preferences'

/**
 * Measured round-trip latency (Settings ▸ Audio ▸ Measure round-trip
 * latency; docs/NATIVE_AUDIO_BACKEND.md §7). App-level and per-machine by
 * nature — a latency describes THIS machine's devices, so it never enters
 * the document, exactly like device selections.
 *
 * What is stored is the measured ROUND TRIP; the input-path trim recording
 * compensation needs is derived at use time as
 * `roundTrip − currentReportedOutputLatency`, so output-latency drift
 * (device renegotiation mid-session) never stales the measurement within
 * the same device setup. The result is keyed by the setup that produced it
 * (input device, output device, sample rate, buffer preference) and simply
 * reads as "unmeasured" when any of them changes — never silently applied
 * to a path it did not measure. The manual trim stays as an offset on top.
 */

export interface StoredCalibration {
  inputDeviceId: string | null
  outputDeviceId: string | null
  sampleRate: number
  latencyHint: string
  roundTripMs: number
  /** What the platform reported when measured — display only. */
  outputLatencyAtMeasureMs: number
  /** Worst peak-to-sidelobe ratio across the repeats. */
  confidence: number
  measuredAt: string
}

const STORAGE_KEY = 'latencyCalibration'
/** Silence between repeats so one sweep's tail never lands in the next. */
const GAP_SEC = 0.3

function sanitizeStored(raw: unknown): StoredCalibration | null {
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as Record<string, unknown>
  const idOk = (v: unknown): v is string | null => v === null || typeof v === 'string'
  const numOk = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
  if (!idOk(r.inputDeviceId) || !idOk(r.outputDeviceId)) return null
  if (!numOk(r.sampleRate) || !numOk(r.roundTripMs) || !numOk(r.outputLatencyAtMeasureMs))
    return null
  if (!numOk(r.confidence) || typeof r.latencyHint !== 'string') return null
  if (typeof r.measuredAt !== 'string') return null
  if (r.roundTripMs < 0 || r.roundTripMs > MAX_LAG_SEC * 1000) return null
  return {
    inputDeviceId: r.inputDeviceId,
    outputDeviceId: r.outputDeviceId,
    sampleRate: r.sampleRate,
    latencyHint: r.latencyHint,
    roundTripMs: r.roundTripMs,
    outputLatencyAtMeasureMs: r.outputLatencyAtMeasureMs,
    confidence: r.confidence,
    measuredAt: r.measuredAt
  }
}

class LatencyCalibrationStore {
  stored: StoredCalibration | null = null
  measuring = false
  /** 1-based pass number while measuring (UI: "sweep 2 of 3"). */
  step = 0
  lastError: string | null = null

  private version = 0
  private listeners = new Set<() => void>()

  constructor() {
    void this.init()
  }

  private async init(): Promise<void> {
    this.stored = sanitizeStored(await appStorageGet<unknown>(STORAGE_KEY))
    this.emit()
  }

  /** Does the stored measurement describe the CURRENT device setup? */
  isCurrent(): boolean {
    const s = this.stored
    if (!s) return false
    if (s.inputDeviceId !== audioDevices.inputDeviceId) return false
    if (s.outputDeviceId !== audioDevices.outputDeviceId) return false
    if (s.latencyHint !== preferences.latencyHint) return false
    const info = audioEngine.contextInfo()
    return info === null || s.sampleRate === info.sampleRate
  }

  /**
   * The measured input-path latency, for recording compensation — or null
   * when unmeasured / measured on a different setup. Derived live against
   * the CURRENT reported output latency (see the module comment).
   */
  autoTrimSec(): number | null {
    if (this.stored === null || !this.isCurrent()) return null
    return this.stored.roundTripMs / 1000 - audioEngine.outputLatencySec()
  }

  /** Play the sweeps and store the result. Errors land in `lastError`. */
  async measure(): Promise<void> {
    if (this.measuring) return
    this.measuring = true
    this.step = 0
    this.lastError = null
    this.emit()
    let deviceKey: string | null = null
    let source: MediaStreamAudioSourceNode | null = null
    try {
      const ctx = audioEngine.ensureContext()
      if (ctx.state === 'suspended') await ctx.resume()
      // null follows the global input selection — the device recording uses.
      const acquired = await trackInputs.acquire(null)
      deviceKey = acquired.key
      source = ctx.createMediaStreamSource(acquired.stream)

      const lags: number[] = []
      let confidence = Number.POSITIVE_INFINITY
      for (let pass = 0; pass < REPEAT_COUNT; pass++) {
        this.step = pass + 1
        this.emit()
        const result = await measureLoopbackOnce(ctx, source)
        if (
          result.confidence < MIN_CONFIDENCE ||
          result.roundTripSec < 0 ||
          result.roundTripSec > MAX_LAG_SEC
        ) {
          throw new Error(
            'The test tone did not come back clearly. Check the loopback connection ' +
              '(or turn the speakers up and the room down) and try again.'
          )
        }
        lags.push(result.roundTripSec)
        confidence = Math.min(confidence, result.confidence)
        if (pass < REPEAT_COUNT - 1) {
          await new Promise((resolve) => setTimeout(resolve, GAP_SEC * 1000))
        }
      }

      const summary = summarizeMeasurements(lags)
      if (!summary || summary.spreadSec > MAX_SPREAD_SEC) {
        throw new Error(
          'The measurements disagreed with each other — the path is unstable. ' +
            'A direct cable loopback gives the steadiest result.'
        )
      }
      this.stored = {
        inputDeviceId: audioDevices.inputDeviceId,
        outputDeviceId: audioDevices.outputDeviceId,
        sampleRate: ctx.sampleRate,
        latencyHint: preferences.latencyHint,
        roundTripMs: summary.roundTripSec * 1000,
        outputLatencyAtMeasureMs: audioEngine.outputLatencySec() * 1000,
        confidence,
        measuredAt: new Date().toISOString()
      }
      void appStorageSet(STORAGE_KEY, this.stored)
    } catch (error) {
      this.lastError =
        error instanceof DOMException && error.name === 'NotAllowedError'
          ? 'Microphone access was denied'
          : error instanceof Error
            ? error.message
            : String(error)
    } finally {
      try {
        source?.disconnect()
      } catch {
        // already disconnected — fine
      }
      if (deviceKey) trackInputs.release(deviceKey)
      this.measuring = false
      this.step = 0
      this.emit()
    }
  }

  clear(): void {
    if (this.stored === null) return
    this.stored = null
    void appStorageSet(STORAGE_KEY, null)
    this.emit()
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getVersion = (): number => this.version

  private emit(): void {
    this.version++
    for (const listener of this.listeners) listener()
  }
}

export const latencyCalibration = new LatencyCalibrationStore()

export function useLatencyCalibration(): LatencyCalibrationStore {
  useSyncExternalStore(latencyCalibration.subscribe, latencyCalibration.getVersion)
  return latencyCalibration
}
