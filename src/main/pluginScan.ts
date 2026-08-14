import { app, BrowserWindow, utilityProcess, type UtilityProcess } from 'electron'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { readdir, stat } from 'node:fs/promises'
import { readAppData, setAppData } from './appData'
import { resolveAddonPath } from './addonPath'
import {
  emptyCache,
  isFresh,
  markUnderInspection,
  normalizeFolders,
  parseCache,
  parseQuarantine,
  pruneToPresent,
  shouldSkip,
  type BundleStamp,
  type ScanCache,
  type ScannedClass,
  type QuarantineEntry
} from './pluginScanCache'

/**
 * Plugin discovery: which folders to search, what was found, and what to do
 * about bundles that misbehave.
 *
 * Three things make this more than a directory walk:
 *
 * 1. Loading a plugin runs third-party native code, so it happens in a
 *    utilityProcess. A segfault or hang costs us the scanner, not the DAW.
 * 2. Inspecting every bundle on every launch is slow (each one loads a
 *    DLL), so results are cached against each bundle's mtime+size.
 * 3. A plugin that took the scanner down is remembered and skipped, until
 *    the user explicitly refreshes — otherwise every launch pays for it
 *    again.
 */

const FOLDERS_KEY = 'pluginFolders'
const CACHE_KEY = 'pluginScanCache'
const QUARANTINE_KEY = 'pluginQuarantine'

/** How long one bundle gets to load before we treat it as hung. */
const INSPECT_TIMEOUT_MS = 15_000

/** Depth guard for the bundle walk; vendors nest a level or two, not ten. */
const MAX_WALK_DEPTH = 4

export interface Vst3Plugin {
  path: string
  uid: string
  name: string
  vendor: string
  version: string
  subCategories: string
}

export interface PluginFailure {
  path: string
  reason: string
  crashed: boolean
}

export interface ScanStatus {
  plugins: Vst3Plugin[]
  folders: string[]
  failures: PluginFailure[]
  scanning: boolean
  /** Null until a scan has completed at least once this session. */
  lastScanMs: number | null
}

/** The standard install locations, used until the user configures their own. */
export function defaultPluginFolders(): string[] {
  const home = homedir()
  if (process.platform === 'win32') {
    const programFiles = process.env['ProgramFiles'] ?? 'C:\\Program Files'
    const localAppData = process.env['LOCALAPPDATA'] ?? join(home, 'AppData', 'Local')
    return normalizeFolders([
      join(programFiles, 'Common Files', 'VST3'),
      join(localAppData, 'Programs', 'Common', 'VST3')
    ])
  }
  if (process.platform === 'darwin') {
    return normalizeFolders([
      '/Library/Audio/Plug-Ins/VST3',
      join(home, 'Library', 'Audio', 'Plug-Ins', 'VST3')
    ])
  }
  return normalizeFolders(['/usr/lib/vst3', '/usr/local/lib/vst3', join(home, '.vst3')])
}

// ---------------------------------------------------------------------------
// Persisted settings
// ---------------------------------------------------------------------------

export async function getFolders(): Promise<string[]> {
  const raw = (await readAppData())[FOLDERS_KEY]
  if (!Array.isArray(raw)) return defaultPluginFolders()
  const folders = normalizeFolders(raw.filter((f): f is string => typeof f === 'string'))
  // An empty list is a real choice (scan nothing), but a never-configured
  // key is not — only the latter falls back to the defaults.
  return folders
}

export async function setFolders(folders: readonly string[]): Promise<string[]> {
  const normalized = normalizeFolders(folders)
  await setAppData(FOLDERS_KEY, normalized)
  return normalized
}

async function readCache(): Promise<ScanCache> {
  return parseCache((await readAppData())[CACHE_KEY])
}

async function readQuarantine(): Promise<Record<string, QuarantineEntry>> {
  return parseQuarantine((await readAppData())[QUARANTINE_KEY])
}

export async function clearQuarantine(): Promise<void> {
  await setAppData(QUARANTINE_KEY, {})
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

/**
 * Every `.vst3` bundle under the configured folders. A bundle is usually a
 * DIRECTORY, so the walk stops descending the moment it sees one — the
 * contents are the plugin's business, not more places to search.
 */
async function discoverBundles(folders: readonly string[]): Promise<string[]> {
  const found: string[] = []
  const seen = new Set<string>()

  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > MAX_WALK_DEPTH) return
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return // missing or unreadable folder is not an error worth surfacing
    }
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.name.toLowerCase().endsWith('.vst3')) {
        const key = process.platform === 'win32' ? full.toLowerCase() : full
        if (!seen.has(key)) {
          seen.add(key)
          found.push(full)
        }
        continue // never descend into a bundle
      }
      if (entry.isDirectory()) await walk(full, depth + 1)
    }
  }

  for (const folder of folders) await walk(folder, 0)
  return found
}

/**
 * The mtime+size a cache entry is validated against. For a bundle
 * directory the interesting file is the binary inside it — a directory's
 * own mtime does not move when a nested file is replaced — so that is
 * preferred, falling back to the bundle itself.
 */
async function stampOf(bundlePath: string): Promise<BundleStamp | null> {
  let info
  try {
    info = await stat(bundlePath)
  } catch {
    return null
  }
  if (!info.isDirectory()) return { mtimeMs: info.mtimeMs, size: info.size }

  // Contents/<arch>/<name>.vst3 is the actual DLL in a bundle layout.
  const name = bundlePath.split(/[\\/]/).pop() ?? ''
  const archDirs = ['x86_64-win', 'x86-win', 'arm64-win', 'MacOS', 'x86_64-linux']
  for (const arch of archDirs) {
    try {
      const binary = await stat(join(bundlePath, 'Contents', arch, name))
      return { mtimeMs: binary.mtimeMs, size: binary.size }
    } catch {
      // try the next layout
    }
  }
  return { mtimeMs: info.mtimeMs, size: info.size }
}

// ---------------------------------------------------------------------------
// The out-of-process inspector
// ---------------------------------------------------------------------------

type InspectOutcome =
  | { kind: 'ok'; classes: ScannedClass[] }
  | { kind: 'error'; reason: string }
  | { kind: 'fatal'; reason: string }

/**
 * Drives the scanner child through a list of bundles, one at a time so a
 * death can always be pinned on a specific plugin. A fatal outcome (crash
 * or hang) respawns the child and continues with the next bundle.
 * `onBefore` is awaited before each bundle is fed to the child — the
 * presume-guilty persistence hook (see markUnderInspection).
 */
async function inspectAll(
  paths: readonly string[],
  addonPath: string,
  onOutcome: (path: string, outcome: InspectOutcome) => void,
  onBefore?: (path: string) => Promise<void>
): Promise<void> {
  const workerScript = join(__dirname, 'pluginScanWorker.js')
  let index = 0

  while (index < paths.length) {
    let child: UtilityProcess
    try {
      child = utilityProcess.fork(workerScript, [addonPath], { stdio: 'ignore' })
    } catch (error) {
      // Cannot even start a scanner: fail the remainder rather than spin.
      const reason = error instanceof Error ? error.message : String(error)
      for (; index < paths.length; index++) onOutcome(paths[index], { kind: 'fatal', reason })
      return
    }

    let dead = false
    const deadPromise = new Promise<void>((resolve) => {
      child.once('exit', () => {
        dead = true
        resolve()
      })
    })

    // Wait for the child to come up (or die trying) before feeding it.
    const started = await Promise.race([
      new Promise<boolean>((resolve) => {
        const onMessage = (message: unknown): void => {
          if ((message as { type?: string })?.type === 'ready') {
            child.off('message', onMessage)
            resolve(true)
          }
        }
        child.on('message', onMessage)
      }),
      deadPromise.then(() => false)
    ])
    if (!started) continue // died on startup; loop respawns

    while (index < paths.length && !dead) {
      const path = paths[index]
      await onBefore?.(path)
      const outcome = await inspectOne(child, path, deadPromise)
      onOutcome(path, outcome)
      index++
      if (outcome.kind === 'fatal') break // respawn for the remaining bundles
    }

    if (!dead) child.kill()
    await deadPromise
  }
}

function inspectOne(
  child: UtilityProcess,
  path: string,
  deadPromise: Promise<void>
): Promise<InspectOutcome> {
  return new Promise<InspectOutcome>((resolve) => {
    let settled = false
    const finish = (outcome: InspectOutcome): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.off('message', onMessage)
      resolve(outcome)
    }

    const onMessage = (message: unknown): void => {
      const reply = message as { type?: string; path?: string; error?: string; classes?: ScannedClass[] }
      if (reply?.type !== 'result' || reply.path !== path) return
      if (reply.error || !reply.classes) {
        finish({ kind: 'error', reason: reply.error ?? 'no audio classes' })
        return
      }
      finish({ kind: 'ok', classes: reply.classes })
    }

    const timer = setTimeout(() => {
      // Hung inside the plugin's own load: kill and blame this bundle.
      finish({ kind: 'fatal', reason: `timed out after ${INSPECT_TIMEOUT_MS / 1000}s` })
      child.kill()
    }, INSPECT_TIMEOUT_MS)

    child.on('message', onMessage)
    void deadPromise.then(() => finish({ kind: 'fatal', reason: 'scanner process crashed' }))
    child.postMessage({ type: 'inspect', path })
  })
}

// ---------------------------------------------------------------------------
// Scan orchestration
// ---------------------------------------------------------------------------

let plugins: Vst3Plugin[] = []
let failures: PluginFailure[] = []
let lastScanMs: number | null = null
let inFlight: Promise<void> | null = null

/**
 * Erases the on-disk under-inspection mark; set only while a bundle is
 * being inspected. The presume-guilty mark exists to survive the app
 * DYING mid-inspection — a deliberate quit is not that, and must not
 * falsely quarantine the innocently-in-flight bundle until a manual
 * refresh. will-quit is held open once while the erase write lands.
 */
let eraseInspectionMark: (() => Promise<void>) | null = null
let quitting = false
app.on('will-quit', (event) => {
  const erase = eraseInspectionMark
  if (!erase || quitting) return
  quitting = true
  eraseInspectionMark = null
  event.preventDefault()
  void erase()
    .catch(() => {}) // a failed erase just costs the pre-fix false positive
    .finally(() => app.quit())
})

/** The current index, synchronously. Empty until the first scan finishes. */
export function currentPlugins(): Vst3Plugin[] {
  return plugins
}

export async function scanStatus(): Promise<ScanStatus> {
  return {
    plugins,
    folders: await getFolders(),
    failures,
    scanning: inFlight !== null,
    lastScanMs
  }
}

/** Scan once per session unless something asks for a refresh. */
export async function ensureScanned(): Promise<void> {
  if (lastScanMs !== null) return
  await rescan(false)
}

export function rescan(forced: boolean): Promise<void> {
  // Coalesce: a refresh click while a scan runs joins that scan rather
  // than starting a competing one.
  if (inFlight) return inFlight
  inFlight = runScan(forced).finally(() => {
    inFlight = null
    notifyRenderers()
  })
  return inFlight
}

function flatten(path: string, classes: readonly ScannedClass[]): Vst3Plugin[] {
  return classes.map((cls) => ({
    path,
    uid: cls.uid,
    name: cls.name,
    vendor: cls.vendor,
    version: cls.version,
    subCategories: cls.subCategories
  }))
}

async function runScan(forced: boolean): Promise<void> {
  const addonPath = resolveAddonPath()
  const folders = await getFolders()
  const bundles = await discoverBundles(folders)

  const cache = forced ? emptyCache() : await readCache()
  const quarantine = await readQuarantine()

  const found: Vst3Plugin[] = []
  const problems: PluginFailure[] = []
  const nextEntries: ScanCache['entries'] = {}
  const nextQuarantine: Record<string, QuarantineEntry> = {}
  const stamps = new Map<string, BundleStamp>()
  const toInspect: string[] = []

  for (const bundle of bundles) {
    const stamp = await stampOf(bundle)
    if (!stamp) continue
    stamps.set(bundle, stamp)

    const quarantined = quarantine[bundle]
    if (shouldSkip(quarantined, forced)) {
      nextQuarantine[bundle] = quarantined!
      problems.push({ path: bundle, reason: quarantined!.reason, crashed: true })
      continue
    }

    const cached = cache.entries[bundle]
    if (isFresh(cached, stamp)) {
      nextEntries[bundle] = cached
      found.push(...flatten(bundle, cached.classes))
      continue
    }
    toInspect.push(bundle)
  }

  if (toInspect.length > 0) {
    if (!addonPath) {
      for (const bundle of toInspect) {
        problems.push({
          path: bundle,
          reason: 'vst3host addon not built (see native/README.md)',
          crashed: false
        })
      }
    } else {
      await inspectAll(
        toInspect,
        addonPath,
        (path, outcome) => {
          if (outcome.kind === 'ok') {
            const stamp = stamps.get(path)
            if (stamp) nextEntries[path] = { stamp, classes: outcome.classes }
            found.push(...flatten(path, outcome.classes))
            return
          }
          const crashed = outcome.kind === 'fatal'
          problems.push({ path, reason: outcome.reason, crashed })
          // Only crashes/hangs earn a quarantine record; a plain load error
          // is cheap to retry and may be fixed by the next plugin update.
          if (crashed) {
            nextQuarantine[path] = { reason: outcome.reason, at: Date.now(), crashed: true }
            // A crasher's REAL reason reaches disk right away (writes are
            // serialized) — not only if the scan lives to its final write.
            void setAppData(QUARANTINE_KEY, { ...nextQuarantine })
          }
        },
        async (path) => {
          // PRESUME GUILTY, persisted before the bundle loads: if this
          // inspection takes the whole app down, the next launch reads the
          // mark as an ordinary crash quarantine and skips the culprit
          // instead of dying the same way on every startup. Results
          // accumulated so far ride along in the same batch, so a death
          // mid-scan also keeps every finished inspection. One small write
          // per DLL load — dwarfed by the load itself; a warm cache scan
          // (the every-launch case) inspects nothing and writes nothing.
          await setAppData(CACHE_KEY, { version: cache.version, entries: { ...nextEntries } })
          if (quitting) return // a new mark after the quit-time erase would outlive the app
          await setAppData(QUARANTINE_KEY, markUnderInspection(nextQuarantine, path, Date.now()))
          // Real crashers accumulated in nextQuarantine survive the erase;
          // only the current path's presumption goes.
          eraseInspectionMark = () => setAppData(QUARANTINE_KEY, { ...nextQuarantine })
        }
      )
    }
  }

  // Every inspection finished writing its real outcome — nothing is
  // presumed guilty anymore, so quitting needs no erase (and a stale one
  // must not overwrite the pruned records below).
  eraseInspectionMark = null

  plugins = found.sort((a, b) => a.name.localeCompare(b.name))
  failures = problems
  lastScanMs = Date.now()

  // Bundles that vanished should not linger in either record.
  await setAppData(CACHE_KEY, {
    version: cache.version,
    entries: pruneToPresent(nextEntries, stamps.keys())
  })
  await setAppData(QUARANTINE_KEY, pruneToPresent(nextQuarantine, stamps.keys()))
}

/**
 * Non-renderer listeners on the index. The audio process resolves live
 * VST3 inserts against it too, but is told over its OWN port — the paths
 * in it must never travel through a renderer. A subscription (rather than
 * this module reaching for the audio host) keeps the dependency one-way.
 */
const indexListeners = new Set<() => void>()

export function subscribePluginIndex(listener: () => void): () => void {
  indexListeners.add(listener)
  return () => indexListeners.delete(listener)
}

function notifyRenderers(): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('plugins:changed')
  }
  for (const listener of indexListeners) listener()
}
