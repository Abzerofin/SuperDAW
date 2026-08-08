import { app } from 'electron'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/**
 * App-level key/value storage (settings, recent-project index, editor
 * window positions) as one JSON file in userData — independent of any
 * project file. Values are opaque JSON owned by callers; this module only
 * persists them. Shared by the appdata IPC (renderer state) and by main
 * itself (machine-local facts like plugin editor positions that the
 * renderer never needs).
 */

const appDataPath = (): string => join(app.getPath('userData'), 'superdaw-appdata.json')
let cache: Record<string, unknown> | null = null

export async function readAppData(): Promise<Record<string, unknown>> {
  if (cache) return cache
  try {
    cache = JSON.parse(await readFile(appDataPath(), 'utf8')) as Record<string, unknown>
  } catch {
    cache = {} // first run, or an unreadable file — start fresh
  }
  return cache
}

let pendingWrite = Promise.resolve()

/** Set one key. Writes are serialized and atomic (temp file + rename). */
export async function setAppData(key: string, value: unknown): Promise<void> {
  const data = await readAppData()
  data[key] = value
  pendingWrite = pendingWrite.then(async () => {
    const path = appDataPath()
    await mkdir(dirname(path), { recursive: true })
    const tmp = `${path}.tmp`
    await writeFile(tmp, JSON.stringify(data, null, 2))
    await rename(tmp, path)
  })
  await pendingWrite
}
