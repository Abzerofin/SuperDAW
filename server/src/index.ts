import { randomBytes } from 'node:crypto'
import { RelayCore, DEFAULT_CONFIG } from '../../src/core/relay/relayCore.ts'
import { startWsRelay } from './wsRelay.ts'

/**
 * SuperDAW collaboration relay — a deliberately tiny, stateless-at-rest
 * process. Run behind a TLS-terminating reverse proxy in production.
 *
 *   node server/src/index.ts          (Node ≥ 23 strips types natively)
 *
 * Env: RELAY_PORT (8787), RELAY_MAX_SESSIONS, RELAY_MAX_GUESTS.
 */

const port = Number(process.env.RELAY_PORT ?? 8787)

const core = new RelayCore({
  ...DEFAULT_CONFIG,
  maxSessions: Number(process.env.RELAY_MAX_SESSIONS ?? DEFAULT_CONFIG.maxSessions),
  maxGuestsPerSession: Number(process.env.RELAY_MAX_GUESTS ?? DEFAULT_CONFIG.maxGuestsPerSession),
  randomByte: () => randomBytes(1)[0]
})

const handle = await startWsRelay(core, port)
console.log(`SuperDAW relay listening on :${port}`)

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void handle.close().then(() => process.exit(0))
  })
}
