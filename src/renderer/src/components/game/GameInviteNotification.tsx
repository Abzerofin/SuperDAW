import { gameState, useGameInvite, useActiveGame } from '@/state/gameState'
import { SpaceInvaders } from './SpaceInvaders'
import './game.css'

export function GameInviteNotification(): React.JSX.Element | null {
  const invite = useGameInvite()
  const activeGame = useActiveGame()

  if (activeGame) {
    return (
      <div className="game-overlay">
        <SpaceInvaders onClose={() => gameState.endGame()} />
      </div>
    )
  }

  if (invite) {
    return (
      <div className="game-invite-overlay">
        <div className="game-invite-modal">
          <div className="invite-content">
            <h3>{invite.from} wants to play Space Invaders!</h3>
            <p>Take a quick mental break and compete for the high score.</p>
          </div>
          <div className="invite-buttons">
            <button className="invite-accept" onClick={() => gameState.acceptInvite()}>
              Accept
            </button>
            <button className="invite-decline" onClick={() => gameState.declineInvite()}>
              Decline
            </button>
          </div>
        </div>
      </div>
    )
  }

  return null
}
