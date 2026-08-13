import { useSyncExternalStore } from 'react'

export interface GameInvite {
  readonly id: string
  readonly from: string
  readonly timestamp: number
}

export interface ActiveGame {
  readonly id: string
  readonly player1: string
  readonly player2: string
  readonly startTime: number
}

/**
 * Transient game state — invites and active games. Not persisted to the
 * project; cleared on app restart.
 */
class GameStateStore {
  private invite: GameInvite | null = null
  private activeGame: ActiveGame | null = null
  private listeners = new Set<() => void>()

  sendInvite(from: string): void {
    this.invite = {
      id: Math.random().toString(36).slice(2),
      from,
      timestamp: Date.now()
    }
    this.emit()
  }

  acceptInvite(): GameInvite | null {
    const accepted = this.invite
    this.invite = null
    if (accepted) {
      this.activeGame = {
        id: Math.random().toString(36).slice(2),
        player1: accepted.from,
        player2: 'self', // Will be set to actual userId by the consumer
        startTime: Date.now()
      }
      this.emit()
    }
    return accepted
  }

  declineInvite(): void {
    this.invite = null
    this.emit()
  }

  endGame(): void {
    this.activeGame = null
    this.emit()
  }

  getInvite(): GameInvite | null {
    return this.invite
  }

  getActiveGame(): ActiveGame | null {
    return this.activeGame
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private emit(): void {
    for (const listener of this.listeners) listener()
  }
}

export const gameState = new GameStateStore()

export function useGameInvite(): GameInvite | null {
  return useSyncExternalStore(gameState.subscribe, () => gameState.getInvite())
}

export function useActiveGame(): ActiveGame | null {
  return useSyncExternalStore(gameState.subscribe, () => gameState.getActiveGame())
}
