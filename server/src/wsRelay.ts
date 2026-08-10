import { WebSocketServer, type WebSocket } from 'ws'
import type { ClientToRelay } from '../../src/core/relay/protocol.ts'
import { RelayCore } from '../../src/core/relay/relayCore.ts'
import type { Conn } from '../../src/core/relay/sessionRegistry.ts'

/**
 * The only module that knows WebSockets exist. Sockets become RelaySinks;
 * frames become parsed messages; silence becomes a close. Everything else
 * is RelayCore.
 */

const SWEEP_INTERVAL_MS = 5_000
const SOCKET_SILENCE_LIMIT_MS = 60_000
/**
 * Big enough for the largest legitimate frame: the host's `welcome`
 * carries the whole project JSON (automation, notes, chat, plugin state
 * blobs), which on a real project easily passes the old 512 KiB cap. A
 * too-small cap here was catastrophic, not graceful: ws kills the HOST's
 * socket with 1009, the host auto-reconnects, re-sends the same welcome,
 * and the session dies in an invisible reconnect loop.
 */
const MAX_FRAME_BYTES = 16 * 1024 * 1024

export interface WsRelayHandle {
  readonly core: RelayCore
  close(): Promise<void>
}

export function startWsRelay(core: RelayCore, port: number): Promise<WsRelayHandle> {
  return new Promise((resolve, reject) => {
    const wss = new WebSocketServer(
      {
        port,
        maxPayload: MAX_FRAME_BYTES,
        // Ops, presence, chat and the welcome snapshot are highly
        // repetitive JSON — deflate cuts them severalfold. Asset chunks
        // are base64 of already-compressed audio; they gain little but
        // cost little, and per-message opt-out isn't available here.
        perMessageDeflate: { threshold: 1024 }
      },
      () => {
        resolve({ core, close })
      }
    )
    wss.on('error', reject)

    const conns = new Map<WebSocket, Conn>()

    wss.on('connection', (socket) => {
      const conn = core.connect(
        {
          send: (message) => {
            if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message))
          },
          close: () => socket.close()
        },
        Date.now()
      )
      conns.set(socket, conn)

      socket.on('message', (raw) => {
        let message: ClientToRelay
        try {
          message = JSON.parse(raw.toString()) as ClientToRelay
          if (typeof message !== 'object' || message === null || typeof message.t !== 'string') {
            throw new Error('not a relay frame')
          }
        } catch {
          conn.sink.send({ t: 'error', code: 'protocol-error', message: 'Unparseable frame' })
          socket.close()
          return
        }
        core.handleMessage(conn, message, Date.now())
      })

      socket.on('close', () => {
        conns.delete(socket)
        core.handleClose(conn, Date.now())
      })
      socket.on('error', () => socket.close())
    })

    // One sweep drives both session expiry and dead-socket reaping.
    const sweep = setInterval(() => {
      const now = Date.now()
      core.tick(now)
      for (const [socket, conn] of conns) {
        if (now - conn.lastSeen > SOCKET_SILENCE_LIMIT_MS) socket.terminate()
      }
    }, SWEEP_INTERVAL_MS)

    async function close(): Promise<void> {
      clearInterval(sweep)
      core.shutdown()
      await new Promise<void>((res) => wss.close(() => res()))
    }
  })
}
