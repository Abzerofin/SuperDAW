import { useSyncExternalStore } from 'react'
import type { TrackId } from '@core/model/types'
import { DEFAULT_INPUT_CHANNELS, type InputChannelConfig } from '@audio/input'
import type { InputHandle } from '@audio/backendTypes'
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

/** MIDI channel filter: 'all', or one channel 1..16. */
export type MidiChannelChoice = 'all' | number

export interface TrackInputConfig {
  /** null = follow the global input device chosen in Settings → Audio. */
  readonly deviceId: string | null
  readonly channels: InputChannelConfig
  readonly monitor: boolean
  /** MIDI tracks: null = follow the global MIDI input (Settings → Audio). */
  readonly midiInputId: string | null
  /** MIDI tracks: which channel this track listens to. */
  readonly midiChannel: MidiChannelChoice
}

const DEFAULT_CONFIG: TrackInputConfig = {
  deviceId: null,
  channels: DEFAULT_INPUT_CHANNELS,
  monitor: false,
  midiInputId: null,
  midiChannel: 'all'
}

/** Stored configs predate fields / may be hand-edited — normalize hard. */
function sanitizeConfig(config: Partial<TrackInputConfig>): TrackInputConfig {
  const midiChannel = config.midiChannel
  return {
    ...DEFAULT_CONFIG,
    ...config,
    // Monitoring never persists: it must be re-armed deliberately, or a
    // launch could start feeding a live mic into the speakers.
    monitor: false,
    midiInputId: typeof config.midiInputId === 'string' ? config.midiInputId : null,
    midiChannel:
      midiChannel === 'all' ||
      (typeof midiChannel === 'number' &&
        Number.isInteger(midiChannel) &&
        midiChannel >= 1 &&
        midiChannel <= 16)
        ? midiChannel
        : 'all'
  }
}

const STORAGE_KEY = 'trackInputs'

/**
 * Why an input would not open, in the user's terms. A denied capture
 * permission arrives as a DOMException from the Web Audio backend; the
 * native backend reports its own reason (no capture device, or an audio
 * process that stopped answering).
 */
export function describeInputError(error: unknown): string {
  if (error instanceof DOMException && error.name === 'NotAllowedError') {
    return 'Microphone access was denied'
  }
  return `Could not open the input: ${error instanceof Error ? error.message : String(error)}`
}

class TrackInputStore {
  private configs = new Map<TrackId, TrackInputConfig>()
  /** Monitoring inputs, by track — recording opens its own (see below). */
  private monitors = new Map<TrackId, InputHandle>()
  /**
   * Channels each device reported the last time an input opened on it, so
   * the panel's channel list survives between opens. Device sharing and
   * reference counting live in the backend now (§7: `openInput` replaced
   * the getUserMedia path wholesale), which is what lets the native
   * duplex stream serve every track from one capture callback.
   */
  private channelCounts = new Map<string, number>()
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

  /** Channels the track's device actually offers (null until one opens). */
  channelCountOf(trackId: TrackId): number | null {
    return this.monitors.get(trackId)?.channelCount ?? null
  }

  isMonitoring(trackId: TrackId): boolean {
    return this.configOf(trackId).monitor
  }

  /** Any live input at all — drives meter liveness while stopped. */
  get anyMonitoring(): boolean {
    return this.monitors.size > 0
  }

  private async load(): Promise<void> {
    const stored = await appStorageGet<Record<string, Partial<TrackInputConfig>>>(STORAGE_KEY)
    if (stored) {
      for (const [trackId, config] of Object.entries(stored)) {
        if (!this.configs.has(trackId)) this.configs.set(trackId, sanitizeConfig(config))
      }
    }
    this.loaded = true
    this.emit()
  }

  /** Update a track's input settings; a live monitor re-taps immediately. */
  async setConfig(trackId: TrackId, patch: Partial<TrackInputConfig>): Promise<void> {
    const next = { ...this.configOf(trackId), ...patch }
    const wasMonitoring = this.monitors.has(trackId)
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
    for (const trackId of [...this.monitors.keys()]) {
      await this.stopMonitor(trackId)
      this.configs.set(trackId, { ...this.configOf(trackId), monitor: false })
    }
    this.emit()
  }

  private async startMonitor(trackId: TrackId): Promise<void> {
    const config = this.configOf(trackId)
    try {
      const handle = await this.openFor(config)
      // The ENGINE connects handle.node into the chain — it owns the
      // connection, this store owns the handle (see setMonitorInput).
      audioEngine.setMonitorInput(trackId, handle)
      this.monitors.set(trackId, handle)
      this.lastError = null
    } catch (error) {
      this.configs.set(trackId, { ...config, monitor: false })
      this.fail(describeInputError(error))
    }
    this.emit()
  }

  private async stopMonitor(trackId: TrackId): Promise<void> {
    const handle = this.monitors.get(trackId)
    if (!handle) return
    audioEngine.setMonitorInput(trackId, null)
    handle.dispose()
    this.monitors.delete(trackId)
  }

  /**
   * Open the live input a config describes. `deviceId: null` follows the
   * global Settings ▸ Audio selection — resolved HERE, because the backend
   * seam deliberately knows nothing about app state.
   */
  async openFor(config: TrackInputConfig): Promise<InputHandle> {
    const deviceId = config.deviceId ?? audioDevices.inputDeviceId
    const handle = await audioEngine.openInput({ ...config.channels, deviceId })
    this.channelCounts.set(deviceId ?? 'default', handle.channelCount)
    this.emit()
    return handle
  }

  /** Channels the device behind a track last reported (for the UI). */
  channelsAvailable(trackId: TrackId): number | null {
    const monitoring = this.monitors.get(trackId)
    if (monitoring) return monitoring.channelCount
    const key = this.configOf(trackId).deviceId ?? audioDevices.inputDeviceId ?? 'default'
    return this.channelCounts.get(key) ?? null
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
