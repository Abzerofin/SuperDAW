/**
 * The sacrificial process that actually loads plugin bundles.
 *
 * Inspecting a VST3 means running a stranger's DLL inside your process. A
 * badly behaved one can segfault or hang, and in the main process that
 * takes the whole DAW down mid-session. So scanning happens out here in a
 * utilityProcess: if a plugin kills this, the parent notices the exit,
 * blames the bundle that was in flight, and carries on.
 *
 * One bundle per message, rather than a batch, precisely so the parent
 * always knows which plugin was being loaded when the lights went out.
 */

/** Set by the parent (it owns `app`, which does not exist out here). */
const addonPath = process.argv[2]

interface Vst3Class {
  uid: string
  name: string
  vendor: string
  version: string
  subCategories: string
}

interface Vst3Addon {
  inspect(path: string): { path: string; error?: string; classes?: Vst3Class[] }
}

interface ParentPort {
  on(channel: 'message', listener: (event: { data: unknown }) => void): void
  postMessage(message: unknown): void
}

const parentPort = (process as unknown as { parentPort: ParentPort }).parentPort

let addon: Vst3Addon | null = null
let loadError: string | null = null

try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  addon = require(addonPath) as Vst3Addon
} catch (error) {
  loadError = error instanceof Error ? error.message : String(error)
}

parentPort.on('message', (event) => {
  const message = event.data as { type?: string; path?: string }
  if (message?.type !== 'inspect' || typeof message.path !== 'string') return
  const path = message.path

  if (!addon) {
    parentPort.postMessage({ type: 'result', path, error: loadError ?? 'addon unavailable' })
    return
  }

  try {
    const info = addon.inspect(path)
    if (info.error || !info.classes) {
      parentPort.postMessage({ type: 'result', path, error: info.error ?? 'no classes' })
      return
    }
    parentPort.postMessage({ type: 'result', path, classes: info.classes })
  } catch (error) {
    // A throw is survivable and reported as data; a hard crash is not, and
    // is what the parent's exit handler is for.
    parentPort.postMessage({
      type: 'result',
      path,
      error: error instanceof Error ? error.message : String(error)
    })
  }
})

parentPort.postMessage({ type: 'ready' })
