import { networkInterfaces } from 'node:os'

/**
 * 169.254.0.0/16 — what an adapter self-assigns when it could not obtain an
 * address at all (APIPA on Windows). It routes nowhere, so advertising one
 * hands every peer an address that cannot possibly reach this machine.
 *
 * A VPN that is INSTALLED BUT NOT CONNECTED sits exactly here: the adapter
 * is present and named, holding only a self-assigned address. Without this
 * filter the name preference below would hand out that dead address in
 * every join code while a perfectly good Wi-Fi address went unused — and
 * LAN sessions fail with no visible error, because the code looks entirely
 * valid and simply points nowhere.
 */
function isLinkLocal(ip: string): boolean {
  return ip.startsWith('169.254.')
}

/**
 * Which local IPv4 address a LAN-hosted session should advertise in its
 * join code. Split out from collabServer.ts (which pulls in Electron) so
 * this pure platform-detection logic is unit-testable without mocking
 * the Electron runtime.
 */
export function pickLanAddress(): string {
  const named: Array<{ name: string; address: string }> = []
  for (const [name, list] of Object.entries(networkInterfaces())) {
    for (const iface of list ?? []) {
      if (iface.family !== 'IPv4' || iface.internal) continue
      if (isLinkLocal(iface.address)) continue
      named.push({ name, address: iface.address })
    }
  }
  // A machine can be multi-homed (regular LAN + a VPN like Tailscale at
  // once); the two peers may only share the VPN, so its adapter — named
  // "Tailscale"/"tailscale0" on every platform — wins whenever present,
  // even though its 100.64.0.0/10 address isn't a "classic" private range.
  // "Present" means CARRYING A USABLE ADDRESS: a merely-installed VPN was
  // filtered out above, so it can no longer outrank a working LAN.
  const viaTailscale = named.find((n) => n.name.toLowerCase().includes('tailscale'))
  if (viaTailscale) return viaTailscale.address

  const candidates = named.map((n) => n.address)
  const isPrivate = (ip: string): boolean =>
    ip.startsWith('192.168.') ||
    ip.startsWith('10.') ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(ip) ||
    /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(ip) // Tailscale CGNAT range
  return candidates.find(isPrivate) ?? candidates[0] ?? '127.0.0.1'
}
