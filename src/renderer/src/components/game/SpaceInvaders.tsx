import { useEffect, useRef } from 'react'

/**
 * The break room. Two collaborators, one board, one score each — no music,
 * which is the point: somewhere for a mind to rest between takes.
 *
 * The canvas is the only view of the game, so the whole simulation lives in
 * a ref and never touches React state. Nothing here re-renders; the loop
 * steps and draws the same data in the same frame.
 */

/** Field geometry. The canvas IS the field, so these are its bounds. */
const WIDTH = 800
const HEIGHT = 640
const SHIP_W = 20
const SHIP_H = 30
const ENEMY_SIZE = 16
const SHIP_SPEED = 5
const BULLET_SPEED = 7
/** A bullet counts as a hit inside this radius of an enemy's centre. */
const HIT_RADIUS = 20

/**
 * The simulation advances in fixed steps, so the game plays at one speed on
 * every machine — stepping by real elapsed time would make a 144Hz screen
 * run 2.4x faster than a 60Hz one, which decides a race between two players
 * before either touches a key.
 */
const STEP_MS = 1000 / 60
/** Catch-up cap: coming back from a tab-away must not fast-forward the absence. */
const MAX_CATCHUP_MS = 250
/**
 * Fire rate is held here rather than by firing on keydown: OS key-repeat
 * rate is a per-machine setting, so the old keydown version handed whoever
 * had the snappier keyboard config a real advantage.
 */
const FIRE_COOLDOWN_MS = 220

const ENEMY_COLS = 10
const ENEMY_SPACING_X = 70
const ENEMY_SPACING_Y = 60
/** Enemies per wave: 13, 16, 19, ... */
const enemyCountFor = (wave: number): number => 10 + wave * 3
/** Enemies win by reaching the line the ships hold. */
const INVASION_LINE = HEIGHT - SHIP_H

/** Keys the game owns — swallowed so they never reach the app behind it. */
const GAME_KEYS = new Set([
  'w',
  'a',
  's',
  'd',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  ' ',
  'Enter'
])

/**
 * Single-character keys are held lowercase. Pressing Shift mid-hold changes
 * what keyup reports ('w' down, 'W' up), which would otherwise leave the key
 * stuck in the held set and the ship gliding forever.
 */
function normKey(key: string): string {
  return key.length === 1 ? key.toLowerCase() : key
}

interface Player {
  x: number
  y: number
  score: number
  /** Milliseconds of simulated time until this player may fire again. */
  cooldown: number
}

interface Vec {
  x: number
  y: number
}

interface Bullet extends Vec {
  /** Whose score a hit credits. */
  player: 1 | 2
}

export interface Game {
  player1: Player
  player2: Player
  enemies: Vec[]
  bullets: Bullet[]
  wave: number
  /** Enemies this wave STARTED with — the denominator for descent speed. */
  waveStartCount: number
  over: boolean
}

/**
 * Descent speed rises as a wave is cleared — the Space Invaders bargain, and
 * what makes clearing the last few the tense part.
 *
 * Keyed to the wave's OWN starting count. An earlier version compared the
 * remaining count against a hardcoded 10, so any wave that started with more
 * than ten enemies produced a NEGATIVE speed and the fleet flew up off the
 * top of the screen — from wave 5 (25 enemies) on, the game was unplayable.
 */
export function enemySpeed(remaining: number, startCount: number, wave: number): number {
  const cleared = startCount === 0 ? 1 : 1 - remaining / startCount
  const withinWave = 0.35 + (2.2 - 0.35) * cleared
  return withinWave * (1 + (wave - 1) * 0.15)
}

export function spawnWave(wave: number): Vec[] {
  const enemies: Vec[] = []
  for (let i = 0; i < enemyCountFor(wave); i++) {
    enemies.push({
      x: (i % ENEMY_COLS) * ENEMY_SPACING_X + 40,
      y: Math.floor(i / ENEMY_COLS) * ENEMY_SPACING_Y + 40
    })
  }
  return enemies
}

export function newGame(): Game {
  return {
    player1: { x: 200, y: HEIGHT - SHIP_H, score: 0, cooldown: 0 },
    player2: { x: 600, y: HEIGHT - SHIP_H, score: 0, cooldown: 0 },
    enemies: spawnWave(1),
    bullets: [],
    wave: 1,
    waveStartCount: enemyCountFor(1),
    over: false
  }
}

const clamp = (v: number, min: number, max: number): number => Math.min(max, Math.max(min, v))

/** Advance one fixed step. Mutates in place — this state is a ref, not props. */
export function step(game: Game, held: Set<string>): void {
  if (game.over) return

  const drive = (p: Player, up: string, down: string, left: string, right: string): void => {
    if (held.has(up)) p.y -= SHIP_SPEED
    if (held.has(down)) p.y += SHIP_SPEED
    if (held.has(left)) p.x -= SHIP_SPEED
    if (held.has(right)) p.x += SHIP_SPEED
    p.x = clamp(p.x, SHIP_W / 2, WIDTH - SHIP_W / 2)
    p.y = clamp(p.y, SHIP_H / 2, HEIGHT - SHIP_H / 2)
  }
  drive(game.player1, 'w', 's', 'a', 'd')
  drive(game.player2, 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight')

  const fire = (p: Player, key: string, player: 1 | 2): void => {
    p.cooldown = Math.max(0, p.cooldown - STEP_MS)
    if (p.cooldown > 0 || !held.has(key)) return
    game.bullets.push({ x: p.x, y: p.y - SHIP_H / 2, player })
    p.cooldown = FIRE_COOLDOWN_MS
  }
  fire(game.player1, ' ', 1)
  fire(game.player2, 'Enter', 2)

  const speed = enemySpeed(game.enemies.length, game.waveStartCount, game.wave)
  for (const e of game.enemies) e.y += speed

  for (const b of game.bullets) b.y -= BULLET_SPEED

  // One pass, so a bullet kills at most one enemy and an enemy dies once.
  // (The previous nested filter re-scanned the list per bullet, letting a
  // single shot score twice where enemies overlapped.)
  const deadEnemies = new Set<number>()
  const spentBullets = new Set<number>()
  game.bullets.forEach((b, bi) => {
    for (let ei = 0; ei < game.enemies.length; ei++) {
      if (deadEnemies.has(ei)) continue
      const e = game.enemies[ei]
      if (Math.hypot(b.x - e.x, b.y - e.y) >= HIT_RADIUS) continue
      deadEnemies.add(ei)
      spentBullets.add(bi)
      if (b.player === 1) game.player1.score++
      else game.player2.score++
      return
    }
  })

  game.enemies = game.enemies.filter((_, i) => !deadEnemies.has(i))
  game.bullets = game.bullets.filter((b, i) => !spentBullets.has(i) && b.y > 0)

  if (game.enemies.some((e) => e.y + ENEMY_SIZE / 2 >= INVASION_LINE)) {
    game.over = true
    return
  }

  if (game.enemies.length === 0) {
    game.wave++
    game.enemies = spawnWave(game.wave)
    game.waveStartCount = game.enemies.length
    game.bullets = []
  }
}

function draw(ctx: CanvasRenderingContext2D, game: Game): void {
  ctx.fillStyle = '#1a1a2e'
  ctx.fillRect(0, 0, WIDTH, HEIGHT)

  ctx.fillStyle = '#e06c75'
  for (const e of game.enemies) {
    ctx.fillRect(e.x - ENEMY_SIZE / 2, e.y - ENEMY_SIZE / 2, ENEMY_SIZE, ENEMY_SIZE)
  }

  ctx.fillStyle = '#abb2bf'
  for (const b of game.bullets) ctx.fillRect(b.x - 2, b.y - 6, 4, 12)

  const ship = (p: Player, color: string): void => {
    ctx.fillStyle = color
    ctx.fillRect(p.x - SHIP_W / 2, p.y - SHIP_H / 2, SHIP_W, SHIP_H)
  }
  ship(game.player1, '#6fbf73')
  ship(game.player2, '#56b6c2')

  ctx.font = '14px monospace'
  ctx.textBaseline = 'top'
  ctx.textAlign = 'left'
  ctx.fillStyle = '#6fbf73'
  ctx.fillText(`P1  ${game.player1.score}`, 16, 14)
  ctx.textAlign = 'right'
  ctx.fillStyle = '#56b6c2'
  ctx.fillText(`${game.player2.score}  P2`, WIDTH - 16, 14)
  ctx.textAlign = 'center'
  ctx.fillStyle = '#8a8f98'
  ctx.fillText(`WAVE ${game.wave}`, WIDTH / 2, 14)

  if (!game.over) return

  ctx.fillStyle = 'rgba(0, 0, 0, 0.72)'
  ctx.fillRect(0, 0, WIDTH, HEIGHT)
  ctx.textAlign = 'center'
  ctx.fillStyle = '#d6d8dd'
  ctx.font = 'bold 32px monospace'
  ctx.fillText('GAME OVER', WIDTH / 2, HEIGHT / 2 - 60)

  const { score: s1 } = game.player1
  const { score: s2 } = game.player2
  ctx.font = '20px monospace'
  ctx.fillText(`P1 ${s1}   —   ${s2} P2`, WIDTH / 2, HEIGHT / 2 - 10)
  ctx.font = '16px monospace'
  ctx.fillStyle = '#8a8f98'
  ctx.fillText(
    s1 === s2 ? 'A draw.' : `Player ${s1 > s2 ? 1 : 2} wins.`,
    WIDTH / 2,
    HEIGHT / 2 + 26
  )
  ctx.fillText('R to play again  ·  Esc to close', WIDTH / 2, HEIGHT / 2 + 64)
}

export function SpaceInvaders({ onClose }: { onClose: () => void }): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const gameRef = useRef<Game>(newGame())
  const heldRef = useRef<Set<string>>(new Set())
  /** Kept in a ref so the loop never restarts when the close handler changes. */
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  // The loop runs once for the life of the component. It used to depend on
  // the game state it set, which tore the loop down and rebuilt it every
  // single frame, and drew from a closure one frame stale.
  useEffect(() => {
    const ctx = canvasRef.current?.getContext('2d')
    if (!ctx) return

    let frame = 0
    let previous = performance.now()
    let accumulated = 0

    const tick = (now: number): void => {
      accumulated = Math.min(accumulated + (now - previous), MAX_CATCHUP_MS)
      previous = now
      while (accumulated >= STEP_MS) {
        step(gameRef.current, heldRef.current)
        accumulated -= STEP_MS
      }
      draw(ctx, gameRef.current)
      frame = requestAnimationFrame(tick)
    }

    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [])

  // Every key the game claims is preventDefault'd: the overlay sits on top
  // of a scrollable app, and the arrows/Space would otherwise scroll the
  // timeline behind it. Global DAW shortcuts stay inert for the whole
  // session — see the game guard in lib/shortcuts.ts.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        onCloseRef.current()
        return
      }
      const key = normKey(e.key)
      // A finished game restarts on R, so a rematch costs no second invite.
      if (key === 'r' && gameRef.current.over) {
        gameRef.current = newGame()
        return
      }
      if (GAME_KEYS.has(key)) e.preventDefault()
      heldRef.current.add(key)
    }
    const onKeyUp = (e: KeyboardEvent): void => {
      heldRef.current.delete(normKey(e.key))
    }
    // A ship must not keep gliding because the window lost focus mid-hold:
    // the keyup lands on whatever took focus, never on us.
    const onBlur = (): void => heldRef.current.clear()

    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('blur', onBlur)
      heldRef.current.clear()
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
      <canvas ref={canvasRef} className="game-canvas" width={WIDTH} height={HEIGHT} />
    </div>
  )
}
