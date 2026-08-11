import { describe as suite, expect, test } from 'vitest'
import {
  CACHE_VERSION,
  emptyCache,
  isFresh,
  markUnderInspection,
  normalizeFolders,
  parseCache,
  parseQuarantine,
  pruneToPresent,
  shouldSkip,
  UNDER_INSPECTION_REASON,
  type CacheEntry
} from '../pluginScanCache'

/**
 * The scan cache is read back from a JSON file on the user's disk, written
 * by this or an older version of the app. Everything here is about not
 * trusting it — a corrupt cache must degrade to "rescan", never to a crash
 * or to plugins silently disappearing.
 */

const cls = {
  uid: 'ABC',
  name: 'Reverb',
  vendor: 'Acme',
  version: '1.0',
  subCategories: 'Fx'
}

const entry = (mtimeMs: number, size: number): CacheEntry => ({
  stamp: { mtimeMs, size },
  classes: [cls]
})

suite('scan cache parsing', () => {
  test('round-trips a well-formed cache', () => {
    const cache = { version: CACHE_VERSION, entries: { 'C:/x.vst3': entry(10, 20) } }
    expect(parseCache(cache)).toEqual(cache)
  })

  test('a version bump discards the cache rather than migrating it', () => {
    const stale = { version: CACHE_VERSION + 1, entries: { 'C:/x.vst3': entry(10, 20) } }
    expect(parseCache(stale)).toEqual(emptyCache())
  })

  test.each([null, undefined, 42, 'nope', [], { version: CACHE_VERSION }])(
    'junk in place of a cache yields an empty one (%s)',
    (raw) => {
      expect(parseCache(raw)).toEqual(emptyCache())
    }
  )

  test('malformed entries are dropped without losing the good ones', () => {
    const parsed = parseCache({
      version: CACHE_VERSION,
      entries: {
        good: entry(1, 2),
        noStamp: { classes: [cls] },
        badStamp: { stamp: { mtimeMs: 'x', size: 2 }, classes: [cls] },
        badClasses: { stamp: { mtimeMs: 1, size: 2 }, classes: [{ uid: 'only' }] },
        notAnObject: 7
      }
    })
    expect(Object.keys(parsed.entries)).toEqual(['good'])
  })
})

suite('freshness', () => {
  test('a cached inspection is reused only when mtime AND size match', () => {
    const cached = entry(100, 500)
    expect(isFresh(cached, { mtimeMs: 100, size: 500 })).toBe(true)
    expect(isFresh(cached, { mtimeMs: 101, size: 500 })).toBe(false)
    // Same timestamp, different bytes: an in-place patch must not be missed.
    expect(isFresh(cached, { mtimeMs: 100, size: 501 })).toBe(false)
  })

  test('an unknown bundle is never fresh', () => {
    expect(isFresh(undefined, { mtimeMs: 1, size: 1 })).toBe(false)
  })
})

suite('quarantine', () => {
  test('parses valid records and drops malformed ones', () => {
    const parsed = parseQuarantine({
      'C:/bad.vst3': { reason: 'crashed', at: 5, crashed: true },
      'C:/ok.vst3': { reason: 'no classes', at: 6 },
      'C:/junk.vst3': { reason: 5, at: 6 },
      'C:/null.vst3': null
    })
    expect(Object.keys(parsed).sort()).toEqual(['C:/bad.vst3', 'C:/ok.vst3'])
    expect(parsed['C:/bad.vst3'].crashed).toBe(true)
    // Absent `crashed` means a plain load error, which is retried freely.
    expect(parsed['C:/ok.vst3'].crashed).toBe(false)
  })

  test('only crashers are skipped, and only until a forced refresh', () => {
    const crashed = { reason: 'crashed', at: 0, crashed: true }
    const failed = { reason: 'no classes', at: 0, crashed: false }

    expect(shouldSkip(crashed, false)).toBe(true)
    expect(shouldSkip(crashed, true)).toBe(false) // refresh retries it
    expect(shouldSkip(failed, false)).toBe(false) // cheap, always retried
    expect(shouldSkip(undefined, false)).toBe(false)
  })
})

suite('presume-guilty inspection marks (crash-safe scanning)', () => {
  test('marking a bundle presumes a crash and preserves other records', () => {
    const existing = { 'C:/old.vst3': { reason: 'crashed', at: 1, crashed: true } }
    const marked = markUnderInspection(existing, 'C:/next.vst3', 42)
    expect(marked['C:/next.vst3']).toEqual({
      reason: UNDER_INSPECTION_REASON,
      at: 42,
      crashed: true
    })
    expect(marked['C:/old.vst3']).toEqual(existing['C:/old.vst3'])
    // Pure transformation: the input record is untouched.
    expect(existing['C:/next.vst3' as keyof typeof existing]).toBeUndefined()
  })

  test('an app death mid-inspection leaves the culprit quarantined on next launch', () => {
    // What the next launch reads back is whatever JSON hit disk: the mark
    // must round-trip the persistence layer as an ordinary crash record.
    const persisted = JSON.parse(JSON.stringify(markUnderInspection({}, 'C:/killer.vst3', 7)))
    const parsed = parseQuarantine(persisted)
    expect(shouldSkip(parsed['C:/killer.vst3'], false)).toBe(true) // skipped, not re-crashed
    expect(shouldSkip(parsed['C:/killer.vst3'], true)).toBe(false) // Refresh retries it
  })

  test('a finished inspection overwrites the mark with the real outcome', () => {
    // The scan writes the accumulated quarantine WITHOUT the mark once the
    // bundle's outcome is known: survived → no record at all; crashed the
    // worker → the fatal record replaces the presumption.
    const marked = markUnderInspection({}, 'C:/fine.vst3', 1)
    expect(shouldSkip(marked['C:/fine.vst3'], false)).toBe(true)

    const survived: Record<string, never> = {} // next write drops the mark
    expect(shouldSkip(survived['C:/fine.vst3'], false)).toBe(false)

    const fatal = { 'C:/bad.vst3': { reason: 'timed out after 15s', at: 2, crashed: true } }
    const nextMark = markUnderInspection(fatal, 'C:/later.vst3', 3)
    expect(nextMark['C:/bad.vst3'].reason).toBe('timed out after 15s')
  })
})

suite('pruning', () => {
  test('records for uninstalled bundles are forgotten', () => {
    const records = { keep: 1, gone: 2 }
    expect(pruneToPresent(records, ['keep', 'other'])).toEqual({ keep: 1 })
  })

  test('an empty disk state clears everything', () => {
    expect(pruneToPresent({ a: 1 }, [])).toEqual({})
  })
})

suite('folder normalization', () => {
  test('trims, drops blanks and strips trailing separators', () => {
    expect(normalizeFolders(['  C:/VST3  ', '', '   ', 'C:/Other/'])).toEqual([
      'C:/VST3',
      'C:/Other'
    ])
  })

  test('de-duplicates while preserving order', () => {
    expect(normalizeFolders(['/b', '/a', '/b'])).toEqual(['/b', '/a'])
  })

  test.runIf(process.platform === 'win32')('duplicates differing only in case collapse', () => {
    expect(normalizeFolders(['C:\\VST3', 'c:\\vst3'])).toEqual(['C:\\VST3'])
  })
})
