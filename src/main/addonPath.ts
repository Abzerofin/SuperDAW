import { app } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Where the compiled VST3 host addon lives. Checked in dev-then-packaged
 * order; shared by the in-process host and by the out-of-process scanner,
 * which cannot resolve it itself (a utilityProcess has no `app`).
 */
export function resolveAddonPath(): string | null {
  return resolveNativeModule('native/vst3host/build/Release/vst3host.node')
}

/** The native audio backend addon (same recipe, same packaging path). */
export function resolveAudiohostPath(): string | null {
  return resolveNativeModule('native/audiohost/build/Release/audiohost.node')
}

function resolveNativeModule(relative: string): string | null {
  const candidates = [
    join(app.getAppPath(), relative),
    join(process.cwd(), relative),
    join(process.resourcesPath ?? '', relative)
  ]
  return candidates.find((path) => existsSync(path)) ?? null
}
