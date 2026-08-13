import { describe, expect, it } from 'vitest'
import { enemySpeed, newGame, spawnWave, step, type Game } from '../SpaceInvaders'

/**
 * The break-room game's simulation. Pure functions over a plain object, so
 * none of this needs a canvas — which is the point of keeping the loop's
 * state out of React.
 */

/** Run n fixed steps with a set of keys held down throughout. */
function run(game: Game, steps: number, held: string[] = []): Game {
  const keys = new Set(held)
  for (let i = 0; i < steps; i++) step(game, keys)
  return game
}

/**
 * An enemy parked out of every bullet's way, high enough not to invade for
 * the length of a test. Clearing the field advances the wave — and a new
 * wave drops the shots still in flight — so a test that wants to watch one
 * wave needs a survivor.
 */
const BYSTANDER = { x: 760, y: 30 }

describe('enemy descent speed', () => {
  it('is always downward, at every wave and every stage of clearing', () => {
    // The bug this pins: speed was measured against a hardcoded 10 rather
    // than the wave's own size, so any wave starting with more than ten
    // enemies went NEGATIVE and the fleet flew up off the top of the screen.
    for (let wave = 1; wave <= 20; wave++) {
      const start = spawnWave(wave).length
      for (let remaining = start; remaining >= 0; remaining--) {
        expect(enemySpeed(remaining, start, wave)).toBeGreaterThan(0)
      }
    }
  })

  it('accelerates as a wave is cleared', () => {
    const start = spawnWave(5).length
    const full = enemySpeed(start, start, 5)
    const half = enemySpeed(Math.floor(start / 2), start, 5)
    const last = enemySpeed(1, start, 5)
    expect(half).toBeGreaterThan(full)
    expect(last).toBeGreaterThan(half)
  })

  it('opens later waves faster than earlier ones', () => {
    const speedAtWaveStart = (wave: number): number => {
      const start = spawnWave(wave).length
      return enemySpeed(start, start, wave)
    }
    expect(speedAtWaveStart(5)).toBeGreaterThan(speedAtWaveStart(1))
  })
})

describe('wave 5 specifically', () => {
  it('descends toward the players rather than retreating upward', () => {
    const game = newGame()
    game.wave = 5
    game.enemies = spawnWave(5)
    game.waveStartCount = game.enemies.length

    const before = game.enemies.map((e) => e.y)
    run(game, 30)
    game.enemies.forEach((e, i) => expect(e.y).toBeGreaterThan(before[i]))
  })
})

describe('scoring', () => {
  it('credits the firing player and spends the bullet', () => {
    const game = newGame()
    game.enemies = [{ x: 100, y: 100 }, { ...BYSTANDER }]
    game.waveStartCount = 2
    game.bullets = [{ x: 100, y: 105, player: 2 }]

    run(game, 1)

    expect(game.player2.score).toBe(1)
    expect(game.player1.score).toBe(0)
    expect(game.enemies).toHaveLength(1)
    expect(game.bullets).toHaveLength(0)
    expect(game.wave).toBe(1)
  })

  it('does not let one bullet score twice on stacked enemies', () => {
    // The previous nested filter re-scanned the enemy list per bullet, so a
    // single shot could collect several overlapping enemies.
    const game = newGame()
    game.enemies = [{ x: 100, y: 100 }, { x: 100, y: 100 }, { ...BYSTANDER }]
    game.waveStartCount = 3
    game.bullets = [{ x: 100, y: 105, player: 1 }]

    run(game, 1)

    expect(game.player1.score).toBe(1)
    expect(game.enemies).toHaveLength(2)
  })
})

describe('firing', () => {
  it('rate-limits a held key instead of firing every frame', () => {
    const game = newGame()
    game.enemies = [{ ...BYSTANDER }]
    game.waveStartCount = 1

    // One second of simulated time. Firing every frame would be 60 shots;
    // the 220ms cooldown allows about five.
    run(game, 60, [' '])

    expect(game.bullets.length).toBeGreaterThan(2)
    expect(game.bullets.length).toBeLessThan(10)
  })

  it('gives both players the same fire rate', () => {
    const withBystander = (): Game => {
      const g = newGame()
      g.enemies = [{ ...BYSTANDER }]
      g.waveStartCount = 1
      return g
    }
    const p1 = run(withBystander(), 60, [' '])
    const p2 = run(withBystander(), 60, ['Enter'])
    expect(p1.bullets.length).toBe(p2.bullets.length)
    expect(p1.bullets.length).toBeGreaterThan(0)
  })
})

describe('ships', () => {
  it('stay inside the field however long a direction is held', () => {
    const game = newGame()
    run(game, 400, ['a', 'w', 'ArrowRight', 'ArrowDown'])
    for (const p of [game.player1, game.player2]) {
      expect(p.x).toBeGreaterThanOrEqual(0)
      expect(p.x).toBeLessThanOrEqual(800)
      expect(p.y).toBeGreaterThanOrEqual(0)
      expect(p.y).toBeLessThanOrEqual(640)
    }
  })
})

describe('waves', () => {
  it('advances and grows once the field is cleared', () => {
    const game = newGame()
    const firstWaveSize = game.enemies.length
    game.enemies = []
    run(game, 1)

    expect(game.wave).toBe(2)
    expect(game.enemies.length).toBeGreaterThan(firstWaveSize)
    expect(game.waveStartCount).toBe(game.enemies.length)
  })

  it('ends the game when enemies reach the players', () => {
    const game = newGame()
    game.enemies = [{ x: 100, y: 600 }]
    run(game, 20)
    expect(game.over).toBe(true)
  })

  it('freezes once over', () => {
    const game = newGame()
    game.enemies = [{ x: 100, y: 600 }]
    run(game, 20)
    const frozen = JSON.stringify(game)
    run(game, 60, ['a', ' '])
    expect(JSON.stringify(game)).toBe(frozen)
  })
})
