import { app } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Where the compiled VST3 host addon lives. Checked in dev-then-packaged
 * order; shared by the in-process host and by the out-of-process scanner,
 * which cannot resolve it itself (a utilityProcess has no `app`).
 */
export function resolveAddonPath(): string | null {
  const candidates = [
    join(app.getAppPath(), 'native/vst3host/build/Release/vst3host.node'),
    join(process.cwd(), 'native/vst3host/build/Release/vst3host.node'),
    join(process.resourcesPath ?? '', 'native/vst3host/build/Release/vst3host.node')
  ]
  return candidates.find((path) => existsSync(path)) ?? null
}
