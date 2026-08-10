import { useSyncExternalStore } from 'react'
import type { TrackId } from '@core/model/types'
import {
  DEFAULT_INPUT_CHANNELS,
  buildInputTap,
  streamChannelCount,
  type InputChannelConfig,
  type InputTap
} from '@audio/input'
import { audioEngine } from './audioInstance'
import { audioDevices } from './audioDevices'
import { appStorageGet, appStorageSet } from './appStorage'

/**
 * Per-track recording input: which device, which hardware channel(s), and
 * whether the track is monitoring.
 *
 * Deliberately NOT document state. A device id means nothing on another
 * machine — the same reason plugin descriptors never carry filesystem
 * paths — so syncing it would make collaborators fight over routing and
 * break project portability. It lives with the other app-level settings
 * (appStorage), keyed by track id, alongside arm state which is likewise
 * per-user. Recorded audio, of course, still reaches the document through
 * ordinary operations.
 */

export interface TrackInputConfig {
  /** null = follow the global input device chosen in Settings → Audio. */
  readonly deviceId: string | null
  readonly channels: InputChannelConfig
  readonly monitor: boolean
}

const DEFAULT_CONFIG: TrackInputConfig = {
  deviceId: null,
  channels: DEFAULT_INPUT_CHANNELS,
  monitor: false
}

const STORAGE_KEY = 'trackInputs'

/** Streams are shared per device and reference-counted across tracks. */
interface PooledStream {
  stream: MediaStream
  refs: number
}

class TrackInputStore {
  private configs = new Map<TrackId, TrackInputConfig>()
  private taps = new Map<TrackId, { tap: InputTap; deviceKey: string }>()
  private pool = new Map<string, PooledStream>()
  private pending = new Map<string, Promise<MediaStream>>()
  private loaded = false
  lastError: string | null = null

  private version = 0
  private listeners = new Set<() => void>()

  constructor() {
    void this.load()
  }

  configOf(trackId: TrackId): TrackInputConfig {
    return this.configs.get(trackId) ?? DEFAULT_CONFIG
  }

  /** Channels the track's device actually offers (null until a stream opens). */
  channelCountOf(trackId: TrackId): number | null {
    const entry = this.taps.get(trackId)
    return entry ? entry.tap.channelCount : null
  }

  isMonitoring(trackId: TrackId): boolean {
    return this.configOf(trackId).monitor
  }

  /** Any live input tap at all — drives meter liveness while stopped. */
  get anyMonitoring(): boolean {
    return this.taps.size > 0
  }

  private async load(): Promise<void> {
    const stored = await appStorageGet<Record<string, TrackInputConfig>>(STORAGE_KEY)
    if (stored) {
      for (const [trackId, config] of Object.entries(stored)) {
        // Monitoring never persists: it must be re-armed deliberately, or a
        // launch could start feeding a live mic into the speakers.
        if (!this.configs.has(trackId)) this.configs.set(trackId, { ...config, monitor: false })
      }
    }
    this.loaded = true
    this.emit()
  }

  /** Update a track's input settings; a live monitor re-taps immediately. */
  async setConfig(trackId: TrackId, patch: Partial<TrackInputConfig>): Promise<void> {
    const next = { ...this.configOf(trackId), ...patch }
    const wasMonitoring = this.taps.has(trackId)
    this.configs.set(trackId, next)
    this.persist()
    this.emit()

    if (wasMonitoring) {
      await this.stopMonitor(trackId)
      if (next.monitor) await this.startMonitor(trackId)
    } else if (next.monitor) {
      await this.startMonitor(trackId)
    }
  }

  async toggleMonitor(trackId: TrackId): Promise<void> {
    await this.setConfig(trackId, { monitor: !this.configOf(trackId).monitor })
  }

  /** Stop monitoring every track (used when tearing down / closing a project). */
  async stopAllMonitors(): Promise<void> {
    for (const trackId of [...this.taps.keys()]) {
      await this.stopMonitor(trackId)
      this.configs.set(trackId, { ...this.configOf(trackId), monitor: false })
    }
    this.emit()
  }

  private async startMonitor(trackId: TrackId): Promise<void> {
    const config = this.configOf(trackId)
    try {
      const { stream, key } = await this.acquire(config.deviceId)
      const ctx = audioEngine.ensureContext()
      if (ctx.state === 'suspended') await ctx.resume()
      const tap = buildInputTap(ctx, stream, config.channels)
      audioEngine.setMonitorSource(trackId, tap.output)
      this.taps.set(trackId, { tap, deviceKey: key })
      this.lastError = null
    } catch (error) {
      this.configs.set(trackId, { ...config, monitor: false })
      this.fail(
        error instanceof DOMException && error.name === 'NotAllowedError'
          ? 'Microphone access was denied — monitoring is off'
          : `Could not open the input: ${error instanceof Error ? error.message : String(error)}`
      )
    }
    this.emit()
  }

  private async stopMonitor(trackId: TrackId): Promise<void> {
    const entry = this.taps.get(trackId)
    if (!entry) return
    audioEngine.setMonitorSource(trackId, null)
    entry.tap.dispose()
    this.taps.delete(trackId)
    this.release(entry.deviceKey)
  }

  // ---------- Stream pool (shared per device, reference-counted) ----------

  /** Open (or reuse) the stream for a track's device. Caller must release. */
  async acquire(deviceId: string | null): Promise<{ stream: MediaStream; key: string }> {
    // null follows the global setting, so resolve it to a concrete key.
    const effective = deviceId ?? audioDevices.inputDeviceId
    const key = effective ?? 'default'
    const existing = this.pool.get(key)
    if (existing) {
      existing.refs++
      return { stream: existing.stream, key }
    }
    // Concurrent acquires of the same device share one getUserMedia call.
    let inflight = this.pending.get(key)
    if (!inflight) {
      inflight = navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          // Ask for a stereo-or-wider capture so multi-input interfaces
          // expose their channels; mono devices simply report 1.
          channelCount: { ideal: 2 },
          ...(effective ? { deviceId: { ideal: effective } } : {})
        }
      })
      this.pending.set(key, inflight)
    }
    try {
      const stream = await inflight
      const pooled = this.pool.get(key)
      if (pooled) {
        pooled.refs++
        return { stream: pooled.stream, key }
      }
      this.pool.set(key, { stream, refs: 1 })
      return { stream, key }
    } finally {
      this.pending.delete(key)
    }
  }

  release(key: string): void {
    const pooled = this.pool.get(key)
    if (!pooled) return
    pooled.refs--
    if (pooled.refs > 0) return
    pooled.stream.getTracks().forEach((t) => t.stop())
    this.pool.delete(key)
  }

  /** Channels the device behind a track currently reports (for the UI). */
  channelsAvailable(trackId: TrackId): number | null {
    const entry = this.taps.get(trackId)
    if (entry) return entry.tap.channelCount
    const key = this.configOf(trackId).deviceId ?? audioDevices.inputDeviceId ?? 'default'
    const pooled = this.pool.get(key)
    return pooled ? streamChannelCount(pooled.stream) : null
  }

  private persist(): void {
    if (!this.loaded) return
    void appStorageSet(STORAGE_KEY, Object.fromEntries(this.configs))
  }

  private fail(message: string): void {
    this.lastError = message
    this.emit()
    setTimeout(() => {
      if (this.lastError === message) {
        this.lastError = null
        this.emit()
      }
    }, 4000)
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

export const trackInputs = new TrackInputStore()

export function useTrackInputs(): TrackInputStore {
  useSyncExternalStore(trackInputs.subscribe, trackInputs.getVersion)
  return trackInputs
}
