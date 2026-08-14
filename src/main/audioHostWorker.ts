/**
 * The audio utilityProcess entry (docs/NATIVE_AUDIO_BACKEND.md §5): a
 * dedicated process so a driver bug or addon crash costs audio, not the
 * app — the pluginScan precedent. Main hands it the addon paths (argv, it
 * owns `app`) and one end of a MessageChannelMain whose other end goes
 * straight to the renderer, so control traffic skips main entirely. All
 * real logic lives in audioHostSession (Electron-free, tested against
 * the real addon over a plain MessageChannel).
 *
 * BOTH native addons load here. That is what makes live VST3 inserts
 * possible: audiohost's realtime callback reaches vst3host's plugins
 * through a plain C table (native/shared/vst3bridge.h) instead of through
 * the 2-second windowed preview. vst3host is optional — an unbuilt or
 * unloadable addon simply leaves external inserts bypassing.
 *
 * Main also pushes the uid → path index over this parentPort rather than
 * over the renderer's port: plugin paths are machine-specific and must
 * never reach the renderer or the document.
 */

import {
  createAudioHostSession,
  type AudioHostSession,
  type AudiohostAddon,
  type Vst3RealtimeAddon
} from './audioHostSession'
import type { HostPluginIndex, PortLike } from '../audio/hostProtocol'

const addonPath = process.argv[2]
const vst3Path = process.argv[3]

interface ElectronMessagePortMain {
  postMessage(message: unknown): void
  on(event: 'message', listener: (event: { data: unknown }) => void): void
  start(): void
}

interface ParentPort {
  on(event: 'message', listener: (event: { data: unknown; ports: ElectronMessagePortMain[] }) => void): void
}

const parentPort = (process as unknown as { parentPort: ParentPort }).parentPort

/** Loaded lazily so a broken vst3host costs external inserts, not audio. */
function loadVst3(): Vst3RealtimeAddon | null {
  if (!vst3Path) return null
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const addon = require(vst3Path) as Partial<Vst3RealtimeAddon>
    return typeof addon.realtimeBridge === 'function' ? (addon as Vst3RealtimeAddon) : null
  } catch {
    return null
  }
}

let session: (AudioHostSession & { pumpFrame(): void }) | null = null
/** Index that arrived before the port did (main pushes both at acquire). */
let pendingPaths: Record<string, string> | null = null

parentPort.on('message', (event) => {
  const message = event.data as HostPluginIndex | null
  if (message !== null && typeof message === 'object' && message.t === 'plugins') {
    if (session) session.setPluginPaths(message.paths)
    else pendingPaths = message.paths
    return
  }

  const port = event.ports[0]
  if (!port || session) return
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const addon = require(addonPath) as AudiohostAddon
  const portLike: PortLike = {
    postMessage: (message) => port.postMessage(message),
    onMessage: (listener) => port.on('message', (e) => listener(e.data)),
    start: () => port.start()
  }
  session = createAudioHostSession(addon, portLike, {
    vst3: loadVst3(),
    pluginPaths: pendingPaths ?? {}
  })
  pendingPaths = null
})
