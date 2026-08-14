/**
 * The audio utilityProcess entry (docs/NATIVE_AUDIO_BACKEND.md §5): a
 * dedicated process so a driver bug or addon crash costs audio, not the
 * app — the pluginScan precedent. Main hands it the addon path (argv, it
 * owns `app`) and one end of a MessageChannelMain whose other end goes
 * straight to the renderer, so control traffic skips main entirely. All
 * real logic lives in audioHostSession (Electron-free, tested against
 * the real addon over a plain MessageChannel).
 */

import { createAudioHostSession, type AudiohostAddon } from './audioHostSession'
import type { PortLike } from '../audio/hostProtocol'

const addonPath = process.argv[2]

interface ElectronMessagePortMain {
  postMessage(message: unknown): void
  on(event: 'message', listener: (event: { data: unknown }) => void): void
  start(): void
}

interface ParentPort {
  on(event: 'message', listener: (event: { data: unknown; ports: ElectronMessagePortMain[] }) => void): void
}

const parentPort = (process as unknown as { parentPort: ParentPort }).parentPort

parentPort.on('message', (event) => {
  const port = event.ports[0]
  if (!port) return
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const addon = require(addonPath) as AudiohostAddon
  const portLike: PortLike = {
    postMessage: (message) => port.postMessage(message),
    onMessage: (listener) => port.on('message', (e) => listener(e.data)),
    start: () => port.start()
  }
  createAudioHostSession(addon, portLike)
})
