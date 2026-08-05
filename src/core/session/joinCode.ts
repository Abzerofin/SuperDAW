/**
 * Join codes encode where to find the host: IPv4 + port + session token,
 * 9 bytes packed as Crockford base32 → "XXXXX-XXXXX-XXXXX". LAN-first by
 * design; an internet rendezvous service can later mint codes in the same
 * shape pointing at a relay. Codes are transcription-friendly: case
 * insensitive, and I/L→1, O→0.
 */

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

export interface JoinTarget {
  readonly host: string // dotted IPv4
  readonly port: number
  readonly token: string // 6 hex chars
}

export function encodeJoinCode(target: JoinTarget): string {
  const parts = target.host.split('.').map(Number)
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) {
    throw new Error(`Not an IPv4 address: ${target.host}`)
  }
  if (!Number.isInteger(target.port) || target.port < 1 || target.port > 65535) {
    throw new Error(`Bad port: ${target.port}`)
  }
  if (!/^[0-9a-f]{6}$/i.test(target.token)) {
    throw new Error('Token must be 6 hex chars')
  }

  const bytes = new Uint8Array(9)
  bytes.set(parts, 0)
  bytes[4] = target.port >> 8
  bytes[5] = target.port & 0xff
  for (let i = 0; i < 3; i++) {
    bytes[6 + i] = parseInt(target.token.slice(i * 2, i * 2 + 2), 16)
  }

  // 9 bytes = 72 bits => 15 base32 chars, grouped in fives.
  let bits = 0
  let acc = 0
  let out = ''
  for (const byte of bytes) {
    acc = (acc << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += ALPHABET[(acc >> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += ALPHABET[(acc << (5 - bits)) & 31]
  return `${out.slice(0, 5)}-${out.slice(5, 10)}-${out.slice(10, 15)}`
}

export function decodeJoinCode(code: string): JoinTarget {
  const cleaned = code
    .toUpperCase()
    .replace(/[\s-]/g, '')
    .replace(/[IL]/g, '1')
    .replace(/O/g, '0')
  if (cleaned.length !== 15) throw new Error('Join codes look like XXXXX-XXXXX-XXXXX')

  let acc = 0
  let bits = 0
  const bytes: number[] = []
  for (const char of cleaned) {
    const value = ALPHABET.indexOf(char)
    if (value === -1) throw new Error(`Invalid character in join code: ${char}`)
    acc = (acc << 5) | value
    bits += 5
    if (bits >= 8) {
      bytes.push((acc >> (bits - 8)) & 0xff)
      bits -= 8
    }
  }
  if (bytes.length < 9) throw new Error('Join code is too short')

  const host = bytes.slice(0, 4).join('.')
  const port = (bytes[4] << 8) | bytes[5]
  const token = bytes
    .slice(6, 9)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
  if (port === 0) throw new Error('Join code contains an invalid port')
  return { host, port, token }
}
