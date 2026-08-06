import type { ClientToRelay, RelayToClient } from '@core/relay/protocol'

/**
 * Connection plumbing to the relay, abstracted as a connector so
 * RelayNetworking can be driven by a real WebSocket (app) or wired
 * directly to a RelayCore instance (tests) — the same trick the session
 * layer uses with MessageSinks.
 */

export interface RelayLink {
  send(message: ClientToRelay): void
  close(): void
}

export interface RelayLinkHandlers {
  onMessage(message: RelayToClient): void
  /** Link is up. `first` is false for automatic reconnects. */
  onOpen(first: boolean): void
  /** Link lost; the connector keeps retrying until close() is called. */
  onDown(): void
}

export type RelayConnector = (handlers: RelayLinkHandlers) => RelayLink

const HEARTBEAT_INTERVAL_MS = 20_000
const SILENCE_LIMIT_MS = 45_000
const BACKOFF_BASE_MS = 1_000
const BACKOFF_CAP_MS = 30_000

/**
 * WebSocket connector with automatic reconnection: exponential backoff
 * with full jitter, app-level heartbeats, and a generation counter so a
 * stale socket can never call back into a newer one.
 */
export function webSocketConnector(url: string): RelayConnector {
  return (handlers) => {
    let generation = 0
    let ws: WebSocket | null = null
    let closed = false
    let attempts = 0
    let opened = false
    let lastHeard = 0
    let heartbeat: ReturnType<typeof setInterval> | null = null
    let retryTimer: ReturnType<typeof setTimeout> | null = null

    const stopTimers = (): void => {
      if (heartbeat !== null) clearInterval(heartbeat)
      heartbeat = null
      if (retryTimer !== null) clearTimeout(retryTimer)
      retryTimer = null
    }

    const connect = (): void => {
      if (closed) return
      const gen = ++generation
      const socket = new WebSocket(url)
      ws = socket

      socket.onopen = () => {
        if (gen !== generation || closed) return
        attempts = 0
        lastHeard = Date.now()
        heartbeat = setInterval(() => {
          if (Date.now() - lastHeard > SILENCE_LIMIT_MS) {
            socket.close() // dead link → onclose → retry
            return
          }
          socket.send(JSON.stringify({ t: 'hb' } satisfies ClientToRelay))
        }, HEARTBEAT_INTERVAL_MS)
        const first = !opened
        opened = true
        handlers.onOpen(first)
      }

      socket.onmessage = (event) => {
        if (gen !== generation || closed) return
        lastHeard = Date.now()
        const message = JSON.parse(String(event.data)) as RelayToClient
        if (message.t === 'hb') return
        handlers.onMessage(message)
      }

      socket.onclose = () => {
        if (gen !== generation || closed) return
        stopTimers()
        handlers.onDown()
        // Full jitter: uniform in [0, min(cap, base * 2^attempts)].
        const ceiling = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** attempts)
        attempts += 1
        retryTimer = setTimeout(connect, Math.random() * ceiling)
      }

      socket.onerror = () => socket.close()
    }

    connect()

    return {
      send: (message) => {
        if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message))
      },
      close: () => {
        closed = true
        generation += 1
        stopTimers()
        ws?.close()
        ws = null
      }
    }
  }
}
