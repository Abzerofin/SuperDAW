import { describe as suite, expect, test, vi } from 'vitest'

const mockInterfaces = vi.hoisted(() => ({ value: {} as Record<string, unknown> }))
vi.mock('node:os', () => ({
  networkInterfaces: () => mockInterfaces.value
}))

const iface = (address: string, internal = false) => [
  { address, family: 'IPv4', internal, netmask: '255.255.255.0', mac: '', cidr: null }
]

suite('pickLanAddress', () => {
  test('a Tailscale adapter wins even alongside a classic private LAN address', async () => {
    mockInterfaces.value = {
      'Ethernet': iface('192.168.1.42'),
      'Tailscale': iface('100.101.102.103')
    }
    const { pickLanAddress } = await import('../lanAddress')
    expect(pickLanAddress()).toBe('100.101.102.103')
  })

  test('matches the Tailscale adapter name case-insensitively (e.g. Linux tailscale0)', async () => {
    mockInterfaces.value = {
      'eth0': iface('10.0.0.5'),
      'tailscale0': iface('100.64.0.7')
    }
    const { pickLanAddress } = await import('../lanAddress')
    expect(pickLanAddress()).toBe('100.64.0.7')
  })

  test('falls back to the CGNAT range check when the adapter is unnamed as Tailscale', async () => {
    // Some setups (e.g. a manually-bridged interface) won't carry the name,
    // but the address itself is still recognizably in Tailscale's range.
    mockInterfaces.value = { 'vpn0': iface('100.90.1.2') }
    const { pickLanAddress } = await import('../lanAddress')
    expect(pickLanAddress()).toBe('100.90.1.2')
  })

  test('prefers classic private ranges over a public address when no VPN is present', async () => {
    mockInterfaces.value = {
      'Ethernet': iface('192.168.1.42'),
      'Public': iface('203.0.113.9')
    }
    const { pickLanAddress } = await import('../lanAddress')
    expect(pickLanAddress()).toBe('192.168.1.42')
  })

  test('skips internal (loopback) and non-IPv4 interfaces', async () => {
    mockInterfaces.value = {
      'lo': iface('127.0.0.1', true),
      'Ethernet': [
        { address: 'fe80::1', family: 'IPv6', internal: false, netmask: '', mac: '', cidr: null },
        ...iface('10.1.2.3')
      ]
    }
    const { pickLanAddress } = await import('../lanAddress')
    expect(pickLanAddress()).toBe('10.1.2.3')
  })

  test('falls back to 127.0.0.1 when nothing usable is found', async () => {
    mockInterfaces.value = { 'lo': iface('127.0.0.1', true) }
    const { pickLanAddress } = await import('../lanAddress')
    expect(pickLanAddress()).toBe('127.0.0.1')
  })

  test('an INSTALLED BUT DISCONNECTED Tailscale must not hijack the real LAN', async () => {
    // The adapter exists and carries the name, but holds only a
    // self-assigned 169.254 address because Tailscale is not logged in.
    // Matching on the name alone handed this dead address to every peer
    // while the working Wi-Fi address went unused, so LAN sessions failed
    // with a join code that looked completely valid.
    mockInterfaces.value = {
      'Tailscale': iface('169.254.83.107'),
      'Wi-Fi': iface('10.0.0.136')
    }
    const { pickLanAddress } = await import('../lanAddress')
    expect(pickLanAddress()).toBe('10.0.0.136')
  })

  test('a link-local address is never advertised, even as the only candidate', async () => {
    // Loopback is useless to a peer, but it is at least honest about being
    // local; a self-assigned address just fails mysteriously.
    mockInterfaces.value = { 'Ethernet': iface('169.254.1.1') }
    const { pickLanAddress } = await import('../lanAddress')
    expect(pickLanAddress()).toBe('127.0.0.1')
  })

  test('a CONNECTED Tailscale still wins over the local LAN', async () => {
    // The disconnected-VPN fix must not cost the cross-network case the
    // name preference exists for: peers who share only the VPN.
    mockInterfaces.value = {
      'Tailscale': iface('100.101.102.103'),
      'Wi-Fi': iface('10.0.0.136')
    }
    const { pickLanAddress } = await import('../lanAddress')
    expect(pickLanAddress()).toBe('100.101.102.103')
  })
})
