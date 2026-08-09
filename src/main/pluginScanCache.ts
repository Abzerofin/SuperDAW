/**
 * Pure scan-cache and quarantine bookkeeping for the VST3 scanner.
 *
 * Deliberately free of Electron and `fs` imports so it can be unit-tested:
 * everything here is a transformation over plain JSON that came out of (or
 * is going into) appData, which is written by users' machines and by older
 * app versions and is therefore never trusted without validation.
 */

/** One audio-processor class exported by a bundle. */
export interface ScannedClass {
  uid: string
  name: string
  vendor: string
  version: string
  subCategories: string
}

/**
 * What makes a cached inspection stale. Size alone misses same-size edits
 * and mtime alone misses clock oddities, so both must match.
 */
export interface BundleStamp {
  mtimeMs: number
  size: number
}

export interface CacheEntry {
  stamp: BundleStamp
  classes: ScannedClass[]
}

export interface ScanCache {
  version: number
  entries: Record<string, CacheEntry>
}

/**
 * A bundle that could not be scanned. `crashed` separates "the plugin
 * returned a load error" (cheap, safe to retry every scan) from "the
 * scanner process died or hung on it" (expensive, retried only when the
 * user explicitly refreshes).
 */
export interface QuarantineEntry {
  reason: string
  at: number
  crashed: boolean
}

/**
 * Bump when the cached shape changes; a mismatch discards the cache rather
 * than trying to migrate it. Re-inspecting is slow but always correct, and
 * a scan cache is by definition reconstructible.
 */
export const CACHE_VERSION = 1

export function emptyCache(): ScanCache {
  return { version: CACHE_VERSION, entries: {} }
}

function isScannedClass(value: unknown): value is ScannedClass {
  if (typeof value !== 'object' || value === null) return false
  const c = value as Record<string, unknown>
  return (
    typeof c.uid === 'string' &&
    typeof c.name === 'string' &&
    typeof c.vendor === 'string' &&
    typeof c.version === 'string' &&
    typeof c.subCategories === 'string'
  )
}

/** Validate whatever appData held, discarding anything malformed. */
export function parseCache(raw: unknown): ScanCache {
  if (typeof raw !== 'object' || raw === null) return emptyCache()
  const cache = raw as Record<string, unknown>
  if (cache.version !== CACHE_VERSION) return emptyCache()
  const rawEntries = cache.entries
  if (typeof rawEntries !== 'object' || rawEntries === null) return emptyCache()

  const entries: Record<string, CacheEntry> = {}
  for (const [path, value] of Object.entries(rawEntries as Record<string, unknown>)) {
    if (typeof value !== 'object' || value === null) continue
    const entry = value as Record<string, unknown>
    const stamp = entry.stamp as Record<string, unknown> | undefined
    if (
      typeof stamp !== 'object' ||
      stamp === null ||
      typeof stamp.mtimeMs !== 'number' ||
      typeof stamp.size !== 'number' ||
      !Array.isArray(entry.classes) ||
      !entry.classes.every(isScannedClass)
    ) {
      continue
    }
    entries[path] = {
      stamp: { mtimeMs: stamp.mtimeMs, size: stamp.size },
      classes: entry.classes
    }
  }
  return { version: CACHE_VERSION, entries }
}

export function parseQuarantine(raw: unknown): Record<string, QuarantineEntry> {
  if (typeof raw !== 'object' || raw === null) return {}
  const out: Record<string, QuarantineEntry> = {}
  for (const [path, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value !== 'object' || value === null) continue
    const entry = value as Record<string, unknown>
    if (typeof entry.reason !== 'string' || typeof entry.at !== 'number') continue
    out[path] = { reason: entry.reason, at: entry.at, crashed: entry.crashed === true }
  }
  return out
}

/** A cached inspection is reusable only when the bundle is byte-identical. */
export function isFresh(entry: CacheEntry | undefined, stamp: BundleStamp): boolean {
  if (!entry) return false
  return entry.stamp.mtimeMs === stamp.mtimeMs && entry.stamp.size === stamp.size
}

/**
 * Drop cache and quarantine records for bundles that are no longer on
 * disk, so uninstalling a plugin actually forgets it (and un-quarantines
 * the path if something else is ever installed there).
 */
export function pruneToPresent<T>(
  records: Record<string, T>,
  presentPaths: Iterable<string>
): Record<string, T> {
  const present = new Set(presentPaths)
  const out: Record<string, T> = {}
  for (const [path, value] of Object.entries(records)) {
    if (present.has(path)) out[path] = value
  }
  return out
}

/**
 * Should this bundle be skipped without loading it?
 *
 * A plugin that merely failed to load is retried on every scan — it is
 * cheap and it may have been fixed. One that took the scanner process down
 * (or hung it) is skipped until the user asks for a refresh, because
 * re-crashing on every launch would make startup slow for no gain.
 */
export function shouldSkip(entry: QuarantineEntry | undefined, forced: boolean): boolean {
  if (!entry) return false
  if (forced) return false
  return entry.crashed
}

/** Folder list normalization: trimmed, de-duplicated, order preserved. */
export function normalizeFolders(folders: readonly string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const folder of folders) {
    const trimmed = folder.trim().replace(/[\\/]+$/, '')
    if (trimmed.length === 0) continue
    // Windows paths are case-insensitive; comparing raw strings would let
    // the same folder be added twice with different casing.
    const key = process.platform === 'win32' ? trimmed.toLowerCase() : trimmed
    if (seen.has(key)) continue
    seen.add(key)
    out.push(trimmed)
  }
  return out
}
