import { app, ipcMain } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

/**
 * VST3 hosting lives in the MAIN process, not the renderer: the renderer
 * runs sandboxed, and a sandboxed preload cannot require a native addon.
 * That also rules out live streaming — SharedArrayBuffer does not cross an
 * Electron process boundary — so this exposes OFFLINE whole-buffer
 * processing only, which is what the freeze/render path wants anyway.
 * See native/README.md.
 */

interface Vst3Class {
  uid: string
  name: string
  vendor: string
  version: string
  sdkVersion: string
  subCategories: string
}

interface Vst3Addon {
  scanPaths(): string[]
  inspect(path: string): { path: string; error?: string; classes?: Vst3Class[] }
  processBuffer(
    path: string,
    uid: string,
    options: { channels: Float32Array[]; sampleRate: number; blockSize?: number }
  ): { error?: string; channels?: Float32Array[] }
}

/** A discovered plugin, flattened to one entry per audio class. */
export interface Vst3Plugin {
  path: string
  uid: string
  name: string
  vendor: string
  version: string
  subCategories: string
}

let addon: Vst3Addon | null = null
let loadError: string | null = null

function loadAddon(): Vst3Addon | null {
  if (addon || loadError) return addon
  const candidates = [
    join(app.getAppPath(), 'native/vst3host/build/Release/vst3host.node'),
    join(process.cwd(), 'native/vst3host/build/Release/vst3host.node'),
    join(process.resourcesPath ?? '', 'native/vst3host/build/Release/vst3host.node')
  ]
  const found = candidates.find((path) => existsSync(path))
  if (!found) {
    loadError = 'vst3host addon not built (see native/README.md)'
    return null
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    addon = require(found) as Vst3Addon
    return addon
  } catch (error) {
    loadError = error instanceof Error ? error.message : String(error)
    return null
  }
}

/** Cached across calls — scanning re-loads every bundle off disk. */
let cachedScan: Vst3Plugin[] | null = null

function scan(): Vst3Plugin[] {
  if (cachedScan) return cachedScan
  const host = loadAddon()
  if (!host) return []
  const plugins: Vst3Plugin[] = []
  for (const path of host.scanPaths()) {
    const info = host.inspect(path)
    // A bundle that fails to load is skipped, never thrown: one broken
    // plugin must not abort the scan.
    if (info.error || !info.classes) continue
    for (const cls of info.classes) {
      plugins.push({
        path,
        uid: cls.uid,
        name: cls.name,
        vendor: cls.vendor,
        version: cls.version,
        subCategories: cls.subCategories
      })
    }
  }
  cachedScan = plugins
  return plugins
}

export function registerVst3Ipc(): void {
  ipcMain.handle('vst3:scan', async (): Promise<Vst3Plugin[]> => scan())

  ipcMain.handle(
    'vst3:process',
    async (
      _event,
      args: { uid: string; channels: Float32Array[]; sampleRate: number }
    ): Promise<{ channels?: Float32Array[]; error?: string }> => {
      const host = loadAddon()
      if (!host) return { error: loadError ?? 'vst3 host unavailable' }
      // The renderer sends a descriptor uid, never a filesystem path —
      // paths are machine-specific and must not enter the document. Main
      // resolves uid -> path against its own scan.
      const plugin = scan().find((p) => p.uid === args.uid)
      if (!plugin) return { error: `plugin not installed: ${args.uid}` }
      try {
        const result = host.processBuffer(plugin.path, plugin.uid, {
          channels: args.channels,
          sampleRate: args.sampleRate
        })
        if (result.error || !result.channels) {
          return { error: result.error ?? 'processing failed' }
        }
        return { channels: result.channels }
      } catch (error) {
        // A third-party binary throwing must not take the app down.
        return { error: error instanceof Error ? error.message : String(error) }
      }
    }
  )
}
