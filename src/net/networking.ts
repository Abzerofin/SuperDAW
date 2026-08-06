import type { ProjectStore } from '@core/state/store'
import type { PresenceData, SessionUser } from '@core/session/protocol'
import type { TransferMeta } from '@core/session/transfer'
import type { HostAssetProvider } from '@core/session/host'
import type { ClientAssetSource } from '@core/session/client'
import type { ProjectState } from '@core/model/types'

/**
 * The networking abstraction — the ONLY surface the app layer sees
 * (docs/NETWORKING.md §3). Implementations: RelayNetworking (internet,
 * every peer dials the relay) and LanNetworking (host's machine serves
 * directly). The UI never touches a WebSocket; this layer never touches
 * React, audio, or Electron APIs beyond what deps inject.
 *
 * Operations deliberately have no send method here: op transport is wired
 * through the ProjectStore (host taps onOperation; a guest's store
 * attaches its ClientSession as SequencerLink). One pipeline, one path —
 * chat and comments ride it as the operations they already are. Presence
 * (cursors, pings) is the one ephemeral channel.
 */

export type NetworkStatus =
  | 'off'
  /** Dialing / waiting for the session to exist. */
  | 'connecting'
  | 'online'
  /** Transport lost; editing continues locally; retrying quietly. */
  | 'reconnecting'
  /** Connected, but the session's host is away (its grace window runs). */
  | 'host-away'

export interface NetworkingEvents {
  onStatusChange(status: NetworkStatus): void
  /** Guest: after every welcome (join or resync). */
  onWelcome(snapshot: ProjectState, users: SessionUser[], you: SessionUser, firstJoin: boolean): void
  /** Host: roster changed (guests came/went). */
  onRosterChange(users: SessionUser[]): void
  onUserJoined(user: SessionUser): void
  onUserLeft(userId: string): void
  onPresence(userId: string, data: PresenceData): void
  onAssetAvailable(meta: TransferMeta): void
  onAssetProgress(assetId: string, receivedBytes: number, totalBytes: number): void
  onAssetComplete(meta: TransferMeta, bytes: Uint8Array): void
  /** The session is over (everyone keeps their local copy). */
  onSessionEnded(reason: string): void
  /** Join-time or protocol failure, one line, non-modal. */
  onError(message: string): void
}

/** Everything an implementation needs from the app, injected once. */
export interface NetworkingDeps {
  store: ProjectStore
  displayName: () => string
  hostAssets: HostAssetProvider
  clientAssets: ClientAssetSource
  events: Partial<NetworkingEvents>
}

export interface CollabNetworking {
  readonly status: NetworkStatus
  readonly role: 'host' | 'guest' | null

  /** Host a session for the current project. Resolves with the join code. */
  createSession(): Promise<{ joinCode: string }>
  /** Join an existing session by code. Resolves once attached. */
  joinSession(code: string): Promise<void>
  /** Leave/stop. The project simply becomes a local project again. */
  leaveSession(): void

  sendPresence(data: PresenceData): void

  requestAsset(assetId: string): void
  /** Guest: announce a local import so the host pulls it. */
  offerAsset(meta: TransferMeta): void
  /** Host: announce a local import so guests fetch it. */
  announceAsset(meta: TransferMeta): void
}
