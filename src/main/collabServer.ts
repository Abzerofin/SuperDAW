import { ipcMain, type WebContents } from 'electron'
import { randomBytes } from 'node:crypto'
import { WebSocketServer, type WebSocket } from 'ws'
import { pickLanAddress } from './lanAddress'

/**
 * Hosting transport: a WebSocket server in the main process acting as a
 * dumb frame relay. All session logic (sequencing, snapshots, presence)
 * lives in the renderer's core code — main only moves strings, so the
 * networking layer stays independent of everything else.
 *
 * Renderer-facing IPC:
 *   invoke 'collab:host-start'  -> { host, port, token } | { error }
 *   invoke 'collab:host-stop'
 *   send   'collab:to-peer'     { connId, data }
 *   send   'collab:kick'        { connId }
 *   on     'collab:peer-connected'    { connId }
 *   on     'collab:peer-message'      { connId, data }
 *   on     'collab:peer-disconnected' { connId }
 *
 * Peers must connect to ws://host:port/<token>; the token (from the join
 * code) gates the socket before any protocol traffic.
 */

/**
 * Liveness. A LAN socket that dies without a FIN — the usual outcome of a
 * VPN reconnect, a sleeping laptop or a NAT timeout — otherwise stays
 * "connected" forever: the host keeps writing every op and 20 Hz presence
 * frame into it while the guest reconnects on a second connection. The
 * relay transport has had this since day one (server/src/wsRelay.ts); the
 * LAN one had nothing, which is why sessions over a VPN drift.
 */
const HEARTBEAT_INTERVAL_MS = 20_000

let server: WebSocketServer | null = null
let sessionToken = ''
let nextConnId = 1
let heartbeat: ReturnType<typeof setInterval> | null = null
const sockets = new Map<number, WebSocket>()
/** Sockets that have answered (pong or traffic) since the last sweep. */
const alive = new WeakSet<WebSocket>()

function stopServer(): void {
  if (heartbeat !== null) clearInterval(heartbeat)
  heartbeat = null
  for (const socket of sockets.values()) socket.close()
  sockets.clear()
  server?.close()
  server = null
  sessionToken = ''
}

export function registerCollabIpc(): void {
  ipcMain.handle('collab:host-start', async (event) => {
    stopServer()
    const sender = event.sender
    sessionToken = randomBytes(3).toString('hex')

    try {
      server = await new Promise<WebSocketServer>((resolvePromise, rejectPromise) => {
        // Port 0: let the OS pick a free port.
        const wss: WebSocketServer = new WebSocketServer({ port: 0, host: '0.0.0.0' }, () =>
          resolvePromise(wss)
        )
        wss.on('error', rejectPromise)
      })
    } catch (error) {
      return { error: `Could not start session server: ${String(error)}` }
    }

    server.on('connection', (socket, request) => {
      if (request.url !== `/${sessionToken}`) {
        socket.close(4001, 'bad token')
        return
      }
      const connId = nextConnId++
      sockets.set(connId, socket)
      alive.add(socket)
      safeSend(sender, 'collab:peer-connected', { connId })

      socket.on('message', (raw) => {
        alive.add(socket)
        safeSend(sender, 'collab:peer-message', { connId, data: raw.toString() })
      })
      socket.on('pong', () => alive.add(socket))
      socket.on('close', () => {
        if (sockets.delete(connId)) {
          safeSend(sender, 'collab:peer-disconnected', { connId })
        }
      })
      socket.on('error', () => socket.close())
    })

    // Ping every peer each interval; one missed round trip terminates the
    // socket, which fires 'close' and retires the peer host-side.
    heartbeat = setInterval(() => {
      for (const socket of sockets.values()) {
        if (!alive.has(socket)) {
          socket.terminate()
          continue
        }
        alive.delete(socket)
        try {
          socket.ping()
        } catch {
          socket.terminate()
        }
      }
    }, HEARTBEAT_INTERVAL_MS)

    const address = server.address()
    const port = typeof address === 'object' && address ? address.port : 0
    return { host: pickLanAddress(), port, token: sessionToken }
  })

  ipcMain.handle('collab:host-stop', () => {
    stopServer()
  })

  ipcMain.on('collab:to-peer', (_event, args: { connId: number; data: string }) => {
    sockets.get(args.connId)?.send(args.data)
  })

  ipcMain.on('collab:kick', (_event, args: { connId: number }) => {
    sockets.get(args.connId)?.close()
  })
}

function safeSend(sender: WebContents, channel: string, payload: unknown): void {
  if (!sender.isDestroyed()) sender.send(channel, payload)
}
