import { open, rename } from 'node:fs/promises'

/**
 * Durable atomic write: temp file + fsync + rename. A crash, power loss or
 * full disk mid-write must never destroy the previous good copy — a .sdaw
 * is a ZIP whose central directory sits at the end, so a truncated file is
 * unreadable in full, not partially. Shared by project saves and the
 * crash-recovery snapshots, which have exactly the same durability needs.
 */
export async function writeFileAtomic(filePath: string, data: Uint8Array): Promise<void> {
  const tmp = `${filePath}.tmp`
  const handle = await open(tmp, 'w')
  try {
    await handle.writeFile(data)
    await handle.sync()
  } finally {
    await handle.close()
  }
  await rename(tmp, filePath)
}

/** Wrap IPC-delivered bytes without copying (Buffer.from(u8) would copy). */
export const asBuffer = (data: Uint8Array): Buffer =>
  Buffer.from(data.buffer, data.byteOffset, data.byteLength)
