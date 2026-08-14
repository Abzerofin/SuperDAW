import { useSyncExternalStore } from 'react'
import { audioEngine } from './audioInstance'
import { appStorageGet, appStorageSet } from './appStorage'

/**
 * Audio device selection — app-level state, persisted via appStorage,
 * never part of a project. Output switches live through
 * AudioEngine.setOutputDevice (AudioContext.setSinkId — no restart);
 * input feeds the recorder's getUserMedia constraints as an `ideal`
 * deviceId, so the platform itself falls back to the closest compatible
 * device when the chosen one is unplugged.
 *
 * On `devicechange`, a vanished selection reverts to the system default
 * and posts a single dismissible notice (status bar, never a popup).
 */

export interface AudioDeviceInfo {
  readonly deviceId: string
  readonly label: string
  readonly groupId: string
}

interface StoredSelection {
  inputDeviceId: string | null
  outputDeviceId: string | null
}

/**
 * Selections are namespaced PER BACKEND (§6): a Web Audio deviceId is an
 * origin-scoped hash and a native one is a WASAPI endpoint id, so there
 * is no honest translation between them — each backend remembers its own.
 * Older single-scope values are read once as the web scope's.
 */
type StoredSelections = Partial<Record<'web' | 'native', StoredSelection>> & Partial<StoredSelection>

const STORAGE_KEY = 'audioDevices'

class AudioDeviceStore {
  inputs: AudioDeviceInfo[] = []
  outputs: AudioDeviceInfo[] = []
  /** null = system default. */
  inputDeviceId: string | null = null
  outputDeviceId: string | null = null
  /** True once device labels are visible (a capture permission was granted). */
  labelsVisible = false
  /** One-shot device-loss message for the status bar. */
  notice: string | null = null

  private version = 0
  private listeners = new Set<() => void>()

  constructor() {
    void this.init()
  }

  /** Which backend's selections these are (see StoredSelections). */
  private scope: 'web' | 'native' = 'web'
  private stored: StoredSelections = {}

  private async init(): Promise<void> {
    this.stored = (await appStorageGet<StoredSelections>(STORAGE_KEY)) ?? {}
    this.scope = audioEngine.backendKind()
    const mine =
      this.stored[this.scope] ??
      // Pre-namespacing values belong to the Web Audio scope.
      (this.scope === 'web'
        ? { inputDeviceId: this.stored.inputDeviceId ?? null, outputDeviceId: this.stored.outputDeviceId ?? null }
        : undefined)
    this.inputDeviceId = mine?.inputDeviceId ?? null
    this.outputDeviceId = mine?.outputDeviceId ?? null
    if (this.outputDeviceId) void audioEngine.setOutputDevice(this.outputDeviceId)
    audioEngine.onDeviceChange(() => void this.refresh(true))
    await this.refresh(false)
  }

  /** Re-enumerate through the ACTIVE backend; optionally handle losses. */
  async refresh(handleLoss: boolean): Promise<void> {
    const devices = await audioEngine.enumerateDevices()
    if (devices.length === 0 && this.inputs.length === 0 && this.outputs.length === 0) return
    // Native labels are always real; Web Audio hides them until a grant.
    this.labelsVisible =
      audioEngine.backendKind() === 'native' || devices.some((d) => !/ device \d+$/.test(d.label))
    this.inputs = devices
      .filter((d) => d.kind === 'input')
      .map((d) => ({ deviceId: d.id, label: d.label, groupId: '' }))
    this.outputs = devices
      .filter((d) => d.kind === 'output')
      .map((d) => ({ deviceId: d.id, label: d.label, groupId: '' }))

    if (handleLoss) {
      if (this.inputDeviceId && !this.inputs.some((d) => d.deviceId === this.inputDeviceId)) {
        this.inputDeviceId = null
        this.persist()
        this.notice = 'Selected input device was disconnected — using the system default.'
      }
      if (this.outputDeviceId && !this.outputs.some((d) => d.deviceId === this.outputDeviceId)) {
        this.outputDeviceId = null
        this.persist()
        void audioEngine.setOutputDevice(null)
        this.notice = 'Selected output device was disconnected — using the system default.'
      }
    }
    this.emit()
  }

  async setInput(deviceId: string | null): Promise<void> {
    this.inputDeviceId = deviceId
    this.persist()
    this.emit()
  }

  async setOutput(deviceId: string | null): Promise<void> {
    this.outputDeviceId = deviceId
    this.persist()
    const ok = await audioEngine.setOutputDevice(deviceId)
    if (!ok && deviceId !== null) {
      this.notice = 'Could not switch the output device — using the system default.'
      this.outputDeviceId = null
      this.persist()
    }
    this.emit()
  }

  /** getUserMedia constraint for the recorder: `ideal` = graceful fallback. */
  inputConstraint(): { deviceId: { ideal: string } } | Record<string, never> {
    return this.inputDeviceId ? { deviceId: { ideal: this.inputDeviceId } } : {}
  }

  /**
   * Device labels require a one-time capture grant; ask, then immediately
   * release the stream and re-enumerate.
   */
  async revealLabels(): Promise<void> {
    if (this.labelsVisible || !navigator.mediaDevices?.getUserMedia) return
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      stream.getTracks().forEach((t) => t.stop())
    } catch {
      return // denied — numbered device names remain
    }
    await this.refresh(false)
  }

  dismissNotice(): void {
    if (this.notice === null) return
    this.notice = null
    this.emit()
  }

  private persist(): void {
    this.stored = {
      ...this.stored,
      [this.scope]: {
        inputDeviceId: this.inputDeviceId,
        outputDeviceId: this.outputDeviceId
      }
    }
    void appStorageSet(STORAGE_KEY, this.stored)
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

export const audioDevices = new AudioDeviceStore()

export function useAudioDevices(): AudioDeviceStore {
  useSyncExternalStore(audioDevices.subscribe, audioDevices.getVersion)
  return audioDevices
}
