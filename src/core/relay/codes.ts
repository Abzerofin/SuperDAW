/**
 * Relay join codes: short, opaque, server-minted. Unlike LAN codes
 * (core/session/joinCode.ts — 15 chars encoding IP+port+token), relay
 * codes locate nothing: they are pure capability tokens looked up in the
 * relay's in-memory session table. The two formats are distinguished by
 * length, so one "Join" box handles both.
 *
 * Same transcription-friendly Crockford alphabet as LAN codes:
 * case-insensitive, I/L→1, O→0. No imports by design (shared with the
 * standalone server).
 */

export const RELAY_CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
export const RELAY_CODE_LENGTH = 8

/** Uppercase, strip separators, fix confusable characters. */
export function normalizeCode(input: string): string {
  return input
    .toUpperCase()
    .replace(/[\s-]/g, '')
    .replace(/[IL]/g, '1')
    .replace(/O/g, '0')
}

/** "AB4XK92P" → "AB4X-K92P" for display. */
export function formatCode(raw: string): string {
  const clean = normalizeCode(raw)
  return clean.length === RELAY_CODE_LENGTH
    ? `${clean.slice(0, 4)}-${clean.slice(4)}`
    : clean
}

/** True if the input looks like a relay code (vs a 15-char LAN code). */
export function isRelayCode(input: string): boolean {
  const clean = normalizeCode(input)
  return (
    clean.length === RELAY_CODE_LENGTH &&
    [...clean].every((c) => RELAY_CODE_ALPHABET.includes(c))
  )
}

/** Mint a code from a caller-supplied random source (server passes crypto). */
export function mintCode(randomByte: () => number): string {
  let code = ''
  for (let i = 0; i < RELAY_CODE_LENGTH; i++) {
    code += RELAY_CODE_ALPHABET[randomByte() % RELAY_CODE_ALPHABET.length]
  }
  return code
}
