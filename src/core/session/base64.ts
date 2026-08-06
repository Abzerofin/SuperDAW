/**
 * Chunk-safe base64 helpers, portable across renderer and Node (both
 * expose btoa/atob as globals). Kept in core so session transfer logic
 * and any transport can share one implementation.
 */

export function u8ToBase64(u8: Uint8Array): string {
  let binary = ''
  const CHUNK = 0x8000
  for (let i = 0; i < u8.length; i += CHUNK) {
    binary += String.fromCharCode(...u8.subarray(i, i + CHUNK))
  }
  return btoa(binary)
}

export function base64ToU8(base64: string): Uint8Array {
  const binary = atob(base64)
  const u8 = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) u8[i] = binary.charCodeAt(i)
  return u8
}
