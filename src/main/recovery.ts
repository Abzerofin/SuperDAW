import { app, ipcMain } from 'electron'
import { access, mkdir, readdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { asBuffer, writeFileAtomic } from './atomicWrite'

/**
 * Crash-recovery storage: a single recovery slot in userData, holding the
 * last autosnapshot of whatever unsaved work was in flight.
 *
 *   recovery/project.json    ordinary project.json (document + manifest +
 *                            lineage + op log) — same format as .sdaw
 *   recovery/meta.json       { name, path, savedAt } for the home-screen
 *                            offer, readable without parsing the document
 *   recovery/assets/<id>.<ext>  original encoded bytes, written ONCE each —
 *                            assets are immutable by id, so a snapshot tick
 *                            rewrites the small JSON, never the audio
 *
 * The renderer owns policy (when to snapshot, when to clear); this module
 * only moves bytes. Everything is atomic so a crash mid-snapshot leaves the
 * previous snapshot intact.
 */

export interface RecoveryMeta {
  readonly name: string
  /** The project's file path at snapshot time (null = never saved). */
  readonly path: string | null
  readonly savedAt: number
}

const recoveryDir = (): string => join(app.getPath('userData'), 'recovery')

/**
 * Asset file names come from the renderer, and asset IDS originate from
 * collaboration peers — treat them as hostile. Only plain `<id>.<ext>`
 * names ever touch the filesystem; anything else is refused (the snapshot
 * then simply lacks that asset, which recovery already tolerates).
 */
const SAFE_ASSET_FILE = /^[A-Za-z0-9_-]{1,120}\.[A-Za-z0-9]{1,16}$/

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

export function registerRecoveryIpc(): void {
  ipcMain.handle(
    'recovery:write-doc',
    async (_event, args: { json: string; name: string; path: string | null }): Promise<void> => {
      const dir = recoveryDir()
      await mkdir(join(dir, 'assets'), { recursive: true })
      await writeFileAtomic(join(dir, 'project.json'), Buffer.from(args.json, 'utf8'))
      const meta: RecoveryMeta = {
        name: String(args.name),
        path: typeof args.path === 'string' ? args.path : null,
        savedAt: Date.now()
      }
      await writeFileAtomic(join(dir, 'meta.json'), Buffer.from(JSON.stringify(meta), 'utf8'))
    }
  )

  // Returns whether the asset was written (false = already present or an
  // unsafe name). Written once per id — snapshot ticks never re-send audio.
  ipcMain.handle(
    'recovery:write-asset',
    async (_event, args: { fileName: string; data: Uint8Array }): Promise<boolean> => {
      if (!SAFE_ASSET_FILE.test(args.fileName)) return false
      const dir = join(recoveryDir(), 'assets')
      const file = join(dir, args.fileName)
      if (await exists(file)) return false
      await mkdir(dir, { recursive: true })
      await writeFileAtomic(file, asBuffer(args.data))
      return true
    }
  )

  ipcMain.handle('recovery:peek', async (): Promise<RecoveryMeta | null> => {
    const dir = recoveryDir()
    try {
      if (!(await exists(join(dir, 'project.json')))) return null
      const raw = JSON.parse(await readFile(join(dir, 'meta.json'), 'utf8')) as RecoveryMeta
      if (typeof raw.name !== 'string' || typeof raw.savedAt !== 'number') return null
      return { name: raw.name, path: typeof raw.path === 'string' ? raw.path : null, savedAt: raw.savedAt }
    } catch {
      return null
    }
  })

  ipcMain.handle(
    'recovery:read',
    async (): Promise<{
      json: string
      path: string | null
      assets: { fileName: string; data: Uint8Array }[]
    } | null> => {
      const dir = recoveryDir()
      try {
        const json = await readFile(join(dir, 'project.json'), 'utf8')
        let path: string | null = null
        try {
          const meta = JSON.parse(await readFile(join(dir, 'meta.json'), 'utf8')) as RecoveryMeta
          if (typeof meta.path === 'string') path = meta.path
        } catch {
          // meta is advisory; the document is what matters
        }
        const assets: { fileName: string; data: Uint8Array }[] = []
        const assetDir = join(dir, 'assets')
        if (await exists(assetDir)) {
          for (const fileName of await readdir(assetDir)) {
            if (!SAFE_ASSET_FILE.test(fileName)) continue // strays and .tmp leftovers
            assets.push({ fileName, data: await readFile(join(assetDir, fileName)) })
          }
        }
        return { json, path, assets }
      } catch {
        return null
      }
    }
  )

  ipcMain.handle('recovery:clear', async (): Promise<void> => {
    await rm(recoveryDir(), { recursive: true, force: true })
  })
}
