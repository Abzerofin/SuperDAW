import { app } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Where the compiled VST3 host addon lives. Checked in dev-then-packaged
 * order; shared by the in-process host and by the out-of-process scanner,
 * which cannot resolve it itself (a utilityProcess has no `app`).
 */
export function resolveAddonPath(): string | null {
  return resolveResourcePath('native/vst3host/build/Release/vst3host.node')
}

/** The native audio backend addon (same recipe, same packaging path). */
export function resolveAudiohostPath(): string | null {
  return resolveResourcePath('native/audiohost/build/Release/audiohost.node')
}

/** The CLAP scanner addon (phase C1, docs/CLAP_AU_HOSTING.md). */
export function resolveClaphostPath(): string | null {
  return resolveResourcePath('native/claphost/build/Release/claphost.node')
}

/** The app/window icon — .ico on Windows for taskbar clarity, .png elsewhere. */
export function resolveIconPath(): string | null {
  const name = process.platform === 'win32' ? 'resources/icon.ico' : 'resources/icon.png'
  return resolveResourcePath(name)
}

function resolveResourcePath(relative: string): string | null {
  const candidates = [
    join(app.getAppPath(), relative),
    join(process.cwd(), relative),
    join(process.resourcesPath ?? '', relative)
  ]
  return candidates.find((path) => existsSync(path)) ?? null
}
