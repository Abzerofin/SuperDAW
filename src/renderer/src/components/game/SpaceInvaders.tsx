import { useEffect, useRef, useState } from 'react'

interface GameState {
  player1: { x: number; y: number; score: number }
  player2: { x: number; y: number; score: number }
  enemies: Array<{ x: number; y: number; id: string }>
  bullets: Array<{ x: number; y: number; playerId: number; id: string }>
  wave: number
  gameOver: boolean
}

export function SpaceInvaders({ onClose }: { onClose: () => void }): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [gameState, setGameState] = useState<GameState>({
    player1: { x: 100, y: 550, score: 0 },
    player2: { x: 700, y: 550, score: 0 },
    enemies: [],
    bullets: [],
    wave: 1,
    gameOver: false
  })

  const keysPressed = useRef<Set<string>>(new Set())
  const gameLoopRef = useRef<number | null>(null)

  // Initialize enemies
  useEffect(() => {
    setGameState((prev) => ({
      ...prev,
      enemies: initializeEnemies(10 + prev.wave * 3)
    }))
  }, [])

  // Game loop
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const gameLoop = () => {
      setGameState((prev) => {
        let next = { ...prev }

        // Handle input
        if (keysPressed.current.has('w')) next.player1.y = Math.max(0, next.player1.y - 5)
        if (keysPressed.current.has('s')) next.player1.y = Math.min(600, next.player1.y + 5)
        if (keysPressed.current.has('a')) next.player1.x = Math.max(0, next.player1.x - 5)
        if (keysPressed.current.has('d')) next.player1.x = Math.min(750, next.player1.x + 5)

        if (keysPressed.current.has('ArrowUp')) next.player2.y = Math.max(0, next.player2.y - 5)
        if (keysPressed.current.has('ArrowDown')) next.player2.y = Math.min(600, next.player2.y + 5)
        if (keysPressed.current.has('ArrowLeft')) next.player2.x = Math.max(0, next.player2.x - 5)
        if (keysPressed.current.has('ArrowRight'))
          next.player2.x = Math.min(750, next.player2.x + 5)

        // Move enemies (accelerate as they die)
        const speed = 0.5 + (10 - next.enemies.length) * 0.1
        next.enemies = next.enemies.map((e) => ({ ...e, y: e.y + speed }))

        // Move bullets
        next.bullets = next.bullets
          .map((b) => ({ ...b, y: b.y - 7 }))
          .filter((b) => b.y > 0)

        // Collision detection
        next.bullets.forEach((bullet) => {
          next.enemies = next.enemies.filter((enemy) => {
            if (
              Math.hypot(bullet.x - enemy.x, bullet.y - enemy.y) < 20
            ) {
              if (bullet.playerId === 1) next.player1.score++
              else next.player2.score++
              return false
            }
            return true
          })
        })
        next.bullets = next.bullets.filter(
          (b) => !next.enemies.some((e) => Math.hypot(b.x - e.x, b.y - e.y) < 20)
        )

        // Check game over (enemies reach bottom)
        if (next.enemies.some((e) => e.y > 640)) {
          next.gameOver = true
        }

        // Check wave clear
        if (next.enemies.length === 0 && !next.gameOver) {
          next.wave++
          next.enemies = initializeEnemies(10 + next.wave * 3)
        }

        return next
      })

      // Draw
      ctx.fillStyle = '#1a1a2e'
      ctx.fillRect(0, 0, 800, 640)

      // Draw player 1
      ctx.fillStyle = '#6fbf73'
      ctx.fillRect(gameState.player1.x - 10, gameState.player1.y - 15, 20, 30)
      ctx.fillText('P1', gameState.player1.x - 8, gameState.player1.y + 25)

      // Draw player 2
      ctx.fillStyle = '#56b6c2'
      ctx.fillRect(gameState.player2.x - 10, gameState.player2.y - 15, 20, 30)
      ctx.fillText('P2', gameState.player2.x - 8, gameState.player2.y + 25)

      // Draw enemies
      ctx.fillStyle = '#e06c75'
      gameState.enemies.forEach((e) => {
        ctx.fillRect(e.x - 8, e.y - 8, 16, 16)
      })

      // Draw bullets
      ctx.fillStyle = '#abb2bf'
      gameState.bullets.forEach((b) => {
        ctx.fillRect(b.x - 2, b.y - 6, 4, 12)
      })

      // Draw scores
      ctx.fillStyle = '#abb2bf'
      ctx.font = '14px monospace'
      ctx.fillText(`P1: ${gameState.player1.score}`, 20, 20)
      ctx.fillText(`P2: ${gameState.player2.score}`, 700, 20)
      ctx.fillText(`Wave ${gameState.wave}`, 350, 20)

      if (gameState.gameOver) {
        ctx.fillStyle = 'rgba(0, 0, 0, 0.7)'
        ctx.fillRect(0, 0, 800, 640)
        ctx.fillStyle = '#abb2bf'
        ctx.font = 'bold 32px monospace'
        ctx.fillText('GAME OVER', 250, 300)
        ctx.font = '20px monospace'
        ctx.fillText(
          `P1: ${gameState.player1.score}  P2: ${gameState.player2.score}`,
          200,
          360
        )
      }

      gameLoopRef.current = requestAnimationFrame(gameLoop)
    }

    gameLoopRef.current = requestAnimationFrame(gameLoop)

    return () => {
      if (gameLoopRef.current) cancelAnimationFrame(gameLoopRef.current)
    }
  }, [gameState])

  // Input handlers
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      keysPressed.current.add(e.key)

      // Shoot
      if (e.key === ' ') {
        e.preventDefault()
        setGameState((prev) => ({
          ...prev,
          bullets: [
            ...prev.bullets,
            {
              x: prev.player1.x,
              y: prev.player1.y - 20,
              playerId: 1,
              id: Math.random().toString()
            }
          ]
        }))
      }
      if (e.key === 'Enter') {
        e.preventDefault()
        setGameState((prev) => ({
          ...prev,
          bullets: [
            ...prev.bullets,
            {
              x: prev.player2.x,
              y: prev.player2.y - 20,
              playerId: 2,
              id: Math.random().toString()
            }
          ]
        }))
      }
    }

    const handleKeyUp = (e: KeyboardEvent) => {
      keysPressed.current.delete(e.key)
    }

    window.addEventListener('keydown', handleKeyDown)
    window.addEventListener('keyup', handleKeyUp)

    return () => {
      window.removeEventListener('keydown', handleKeyDown)
      window.removeEventListener('keyup', handleKeyUp)
    }
  }, [])

  return (
    <div className="game-modal">
      <div className="game-header">
        <h2>Space Invaders</h2>
        <button className="game-close" onClick={onClose} title="Close game (Esc)">
          ✕
        </button>
      </div>
      <div className="game-controls">
        <div>
          <strong>Player 1:</strong> WASD move, Space shoot
        </div>
        <div>
          <strong>Player 2:</strong> Arrows move, Enter shoot
        </div>
      </div>
      <canvas ref={canvasRef} className="game-canvas" width={800} height={640} />
    </div>
  )
}

function initializeEnemies(count: number): Array<{ x: number; y: number; id: string }> {
  const enemies = []
  for (let i = 0; i < count; i++) {
    enemies.push({
      x: (i % 10) * 70 + 40,
      y: Math.floor(i / 10) * 60 + 40,
      id: Math.random().toString()
    })
  }
  return enemies
}
