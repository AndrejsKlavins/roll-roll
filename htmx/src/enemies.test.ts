import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseDice, parseEnemyTemplates } from './enemies'
import { loadRules } from './rules'
import { Session } from './session'

const dirs: string[] = []
const opened: Session[] = []
afterEach(() => {
  for (const s of opened.splice(0)) s.close()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), 'roll-enemy-'))
  dirs.push(dir)
  return dir
}
/** A session on the real rules file (its starter enemies), and a way to reopen it from its log. */
const realSession = async () => {
  const rules = await loadRules()
  const db = join(tempDir(), 'session.db')
  const s = new Session(rules, db)
  opened.push(s)
  const reopen = () => {
    const again = new Session(rules, db)
    opened.push(again)
    return again
  }
  return { s, reopen }
}

describe('enemy templates in the rules file', () => {
  test('the starter list loads, with the numbers the GM gave for rat, wolf and combat midge', async () => {
    const { enemies } = await loadRules()
    const byId = Object.fromEntries(enemies.map((t) => [t.id, t]))
    expect(byId.rat!.stats).toEqual({
      health: 0,
      mind: 1,
      hitDice: 2,
      hitRank: 1,
      hitBonus: -1,
      damageDice: 2,
      damageRank: 1,
      damageBonus: -1,
      evasion: 10,
      physicalResistance: 0,
      mentalResistance: 1,
      speed: 4,
    })
    expect(byId.wolf!.stats).toMatchObject({ health: 3, hitRank: 3, hitBonus: 3, damageBonus: 1, evasion: 8, physicalResistance: 3, speed: 3 })
    expect(byId.combat_midge!.stats).toMatchObject({ health: 1, hitRank: 2, hitBonus: 1, damageRank: 1, damageBonus: 1, evasion: 5, physicalResistance: 3, speed: 3 })
    expect(enemies.length).toBeGreaterThan(10)
  })

  test('dice read as count, d6 and rank; a bad row is reported', () => {
    expect(parseDice('2d6(3)')).toEqual({ dice: 2, rank: 3 })
    expect(parseDice('3D6(-1)')).toEqual({ dice: 3, rank: -1 })
    expect(parseDice('2d6')).toEqual({ dice: 2, rank: 3 })
    expect(parseDice('2d8(3)')).toBeNull()
    const errors: string[] = []
    parseEnemyTemplates([{ id: 'x', name: 'X', hit: 'lots', damage: '1d6(3)', health: 1 }], (m) => errors.push(m))
    expect(errors.some((m) => m.includes('hit must look like 2d6(3)'))).toBe(true)
    expect(errors.some((m) => m.includes('evasion must be a number'))).toBe(true)
  })

  test('a broken enemies list stops the rules from loading', async () => {
    const dir = tempDir()
    const path = join(dir, 'rules.yaml')
    const real = await Bun.file(join(import.meta.dir, '..', 'system', 'rules.yaml')).text()
    writeFileSync(path, real.replace('hit: 2d6(1), hit_bonus: -1', 'hit: two dice, hit_bonus: -1'))
    await expect(loadRules(path)).rejects.toThrow(/enemies\[0\]: hit must look like 2d6\(3\)/)
  })
})

describe('bestiary', () => {
  test('templates: edit a built-in, add a new one, delete one, reset — and it all survives a reopen', async () => {
    const { s, reopen } = await realSession()
    const b = s.bestiary
    expect(b.template('wolf')!.stats.hitBonus).toBe(3)
    expect(s.saveEnemyTemplate({ id: 'wolf', name: 'Dire wolf', stats: { hitBonus: '4', evasion: '9' } }, 'GM')).toBe(true)
    expect(b.template('wolf')).toMatchObject({ name: 'Dire wolf', stats: { hitBonus: 4, evasion: 9, health: 3 } })
    expect(b.isEdited('wolf')).toBe(true)

    // A new one needs every stat; numbers are rounded and clamped.
    const stats = { ...b.template('rat')!.stats, speed: 99, evasion: 6.6 }
    expect(s.saveEnemyTemplate({ name: '  Sewer   king ', stats: { health: 1 } }, 'GM')).toBe(false)
    expect(s.saveEnemyTemplate({ name: '  Sewer   king ', description: 'Rules the rats.', stats }, 'GM')).toBe(true)
    const king = b.templates().at(-1)!
    expect(king).toMatchObject({ name: 'Sewer king', description: 'Rules the rats.', stats: { speed: 20, evasion: 7 } })
    expect(b.isBuiltin(king.id)).toBe(false)

    expect(s.deleteEnemyTemplate('rat', 'GM')).toBe(true)
    expect(b.template('rat')).toBeUndefined()
    expect(s.deleteEnemyTemplate('rat', 'GM')).toBe(false)

    const again = reopen().bestiary
    expect(again.template('wolf')!.name).toBe('Dire wolf')
    expect(again.template('rat')).toBeUndefined()
    expect(again.template(king.id)!.name).toBe('Sewer king')

    expect(s.resetEnemyTemplate('wolf', 'GM')).toBe(true)
    expect(b.template('wolf')!.name).toBe('Wolf')
    expect(b.template('wolf')!.stats.hitBonus).toBe(3)
    expect(b.isEdited('wolf')).toBe(false)
    expect(s.resetEnemyTemplate('wolf', 'GM')).toBe(false) // nothing left to reset
  })

  test('spawning numbers each copy after the ones already there; copies are independent', async () => {
    const { s, reopen } = await realSession()
    const b = s.bestiary
    expect(s.spawnEnemies('wolf', 2, 'GM')).toBe(true)
    expect(s.spawnEnemies('wolf', 1, 'GM')).toBe(true)
    expect(s.spawnEnemies('wolf', 0, 'GM')).toBe(false)
    expect(s.spawnEnemies('nope', 1, 'GM')).toBe(false)
    expect(b.enemies.map((e) => e.name)).toEqual(['Wolf 1', 'Wolf 2', 'Wolf 3'])
    const [w1, w2] = b.enemies
    expect(w1!.health).toBe(3)

    // Tweak one wolf; the other and the template stay as they were.
    expect(s.updateEnemy(w1!.id, 'evasion', '10', 'GM')).toBe(true)
    expect(s.updateEnemy(w1!.id, 'name', 'Alpha', 'GM')).toBe(true)
    expect(w1!.stats.evasion).toBe(10)
    expect(w2!.stats.evasion).toBe(8)
    expect(b.template('wolf')!.stats.evasion).toBe(8)
    // Nothing changes → nothing logged.
    expect(s.updateEnemy(w1!.id, 'evasion', '10', 'GM')).toBe(false)
    expect(s.updateEnemy(w1!.id, 'bogus', '1', 'GM')).toBe(false)

    // A template edited later doesn't reach wolves already spawned.
    s.saveEnemyTemplate({ id: 'wolf', name: 'Wolf', stats: { speed: 5 } }, 'GM')
    expect(w2!.stats.speed).toBe(3)

    expect(reopen().bestiary.enemies.map((e) => [e.name, e.stats.evasion])).toEqual([
      ['Alpha', 10],
      ['Wolf 2', 8],
      ['Wolf 3', 8],
    ])
  })

  test('health and mind: −/+ stays at or under the max, goes below 0 (down), max pulls current down', async () => {
    const { s } = await realSession()
    const b = s.bestiary
    s.spawnEnemies('combat_midge', 1, 'GM')
    const m = b.enemies[0]!
    expect(s.adjustEnemyPool(m.id, 'health', 1, 'GM')).toBe(false) // already full (1 / 1)
    s.adjustEnemyPool(m.id, 'health', -1, 'GM')
    s.adjustEnemyPool(m.id, 'health', -1, 'GM')
    expect(m.health).toBe(-1)
    expect(s.updateEnemy(m.id, 'health', '7', 'GM')).toBe(true) // typed: capped at the max
    expect(m.health).toBe(1)
    s.updateEnemy(m.id, 'maxHealth', '4', 'GM')
    expect([m.health, m.stats.health]).toEqual([1, 4]) // a higher max doesn't heal
    s.updateEnemy(m.id, 'health', '4', 'GM')
    s.updateEnemy(m.id, 'maxHealth', '2', 'GM')
    expect([m.health, m.stats.health]).toEqual([2, 2]) // a lower max pulls it down
    s.adjustEnemyPool(m.id, 'mind', -1, 'GM')
    expect(m.mind).toBe(-1)
  })

  test('acting order is fastest first; remove defeated, one, or all', async () => {
    const { s } = await realSession()
    const b = s.bestiary
    s.spawnEnemies('zombie', 1, 'GM') // speed 2
    s.spawnEnemies('rat', 2, 'GM') // speed 4
    s.spawnEnemies('wolf', 1, 'GM') // speed 3
    expect(b.bySpeed().map((e) => e.name)).toEqual(['Rat 1', 'Rat 2', 'Wolf 1', 'Zombie 1'])

    expect(s.removeEnemies('defeated', 'GM')).toBe(false) // nobody is down
    const rat1 = b.enemies.find((e) => e.name === 'Rat 1')!
    s.adjustEnemyPool(rat1.id, 'health', -1, 'GM')
    expect(s.removeEnemies('defeated', 'GM')).toBe(true)
    expect(b.enemies.map((e) => e.name)).toEqual(['Zombie 1', 'Rat 2', 'Wolf 1'])
    // Numbering carries on after the highest still there.
    s.spawnEnemies('rat', 1, 'GM')
    expect(b.enemies.at(-1)!.name).toBe('Rat 3')

    expect(s.removeEnemies([b.enemies[0]!.id], 'GM')).toBe(true)
    expect(s.removeEnemies('all', 'GM')).toBe(true)
    expect(b.enemies).toHaveLength(0)
  })
})
