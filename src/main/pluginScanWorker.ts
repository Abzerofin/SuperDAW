/**
 * The sacrificial process that actually loads plugin bundles.
 *
 * Inspecting a plugin means running a stranger's DLL inside your process. A
 * badly behaved one can segfault or hang, and in the main process that
 * takes the whole DAW down mid-session. So scanning happens out here in a
 * utilityProcess: if a plugin kills this, the parent notices the exit,
 * blames the bundle that was in flight, and carries on.
 *
 * One bundle per message, rather than a batch, precisely so the parent
 * always knows which plugin was being loaded when the lights went out.
 *
 * Two formats, one worker: argv[2] is the vst3host addon path and argv[3]
 * the claphost addon path (either may be empty when unbuilt); the parent
 * names each bundle's format in the inspect message. Both addons expose
 * the identical `inspect(path)` shape by design.
 */

/** Set by the parent (it owns `app`, which does not exist out here). */
const addonPaths: Record<string, string> = {
  vst3: process.argv[2] ?? '',
  clap: process.argv[3] ?? ''
}

interface ScannedClass {
  uid: string
  name: string
  vendor: string
  version: string
  subCategories: string
}

interface ScannerAddon {
  inspect(path: string): { path: string; error?: string; classes?: ScannedClass[] }
}

interface ParentPort {
  on(channel: 'message', listener: (event: { data: unknown }) => void): void
  postMessage(message: unknown): void
}

const parentPort = (process as unknown as { parentPort: ParentPort }).parentPort

const addons: Record<string, ScannerAddon | null> = {}
const loadErrors: Record<string, string> = {}

function addonFor(format: string): ScannerAddon | null {
  if (format in addons) return addons[format]
  const path = addonPaths[format] ?? ''
  if (path === '') {
    addons[format] = null
    loadErrors[format] = `${format} scanner addon unavailable`
    return null
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    addons[format] = require(path) as ScannerAddon
  } catch (error) {
    addons[format] = null
    loadErrors[format] = error instanceof Error ? error.message : String(error)
  }
  return addons[format]
}

parentPort.on('message', (event) => {
  const message = event.data as { type?: string; path?: string; format?: string }
  if (message?.type !== 'inspect' || typeof message.path !== 'string') return
  const path = message.path
  // Older parents sent no format; everything they scanned was VST3.
  const format = message.format === 'clap' ? 'clap' : 'vst3'

  const addon = addonFor(format)
  if (!addon) {
    parentPort.postMessage({
      type: 'result',
      path,
      error: loadErrors[format] ?? 'addon unavailable'
    })
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
