import { ipcMain, type WebContents } from 'electron'
import { randomBytes } from 'node:crypto'
import { networkInterfaces } from 'node:os'
import { WebSocketServer, type WebSocket } from 'ws'

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

let server: WebSocketServer | null = null
let sessionToken = ''
let nextConnId = 1
const sockets = new Map<number, WebSocket>()

function pickLanAddress(): string {
  const candidates: string[] = []
  for (const list of Object.values(networkInterfaces())) {
    for (const iface of list ?? []) {
      if (iface.family !== 'IPv4' || iface.internal) continue
      candidates.push(iface.address)
    }
  }
  // Prefer classic private ranges; fall back to anything non-internal.
  const isPrivate = (ip: string): boolean =>
    ip.startsWith('192.168.') ||
    ip.startsWith('10.') ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(ip)
  return candidates.find(isPrivate) ?? candidates[0] ?? '127.0.0.1'
}

function stopServer(): void {
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
      safeSend(sender, 'collab:peer-connected', { connId })

      socket.on('message', (raw) => {
        safeSend(sender, 'collab:peer-message', { connId, data: raw.toString() })
      })
      socket.on('close', () => {
        if (sockets.delete(connId)) {
          safeSend(sender, 'collab:peer-disconnected', { connId })
        }
      })
      socket.on('error', () => socket.close())
    })

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
