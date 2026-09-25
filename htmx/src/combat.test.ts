import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { glancingDrop, hitTier, pointsToNextTier, pointsToNextWound, woundsFor } from './combat'
import { loadRules } from './rules'
import { enemyAttackMath, Session, type ChallengeSide } from './session'

const dirs: string[] = []
const opened: Session[] = []
afterEach(() => {
  for (const s of opened.splice(0)) s.close()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

/** The real rules (evasion, resistances, health, the starter enemies), one finished character, a reopen. */
const fight = async () => {
  const rules = await loadRules()
  const dir = mkdtempSync(join(tmpdir(), 'roll-combat-'))
  dirs.push(dir)
  const db = join(dir, 'session.db')
  const s = new Session(rules, db)
  opened.push(s)
  const mara = s.createCharacter('Mara').id
  s.finalizeCharacter(mara, 'Mara')
  const reopen = () => {
    const again = new Session(rules, db)
    opened.push(again)
    return again
  }
  return { s, mara, reopen }
}

const side = (dice: number[]): ChallengeSide => ({ faces: dice, dice, sum: dice.reduce((a, b) => a + b, 0) })

describe('combat tables', () => {
  test('hit tiers by margin, and what each does to the damage', () => {
    const ids = [-9, -3, -2, -1, 0, 2, 3, 5, 6, 8, 9, 30].map((m) => hitTier(m).id)
    expect(ids).toEqual(['miss', 'miss', 'glancing', 'glancing', 'normal', 'normal', 'good', 'good', 'great', 'great', 'critical', 'critical'])
    expect(hitTier(4).damageBonus).toBe(1)
    expect(hitTier(7).damageBonus).toBe(2)
    expect(hitTier(10)).toMatchObject({ extraDie: true, damageBonus: 0 }) // not cumulative
    expect(pointsToNextTier(-5)).toBe(3)
    expect(pointsToNextTier(4)).toBe(2)
    expect(pointsToNextTier(12)).toBeNull()
  })

  test('wounds: none below 0, then one more every 3, uncapped', () => {
    expect([-1, 0, 2, 3, 5, 6, 9, 12].map(woundsFor)).toEqual([0, 1, 1, 2, 2, 3, 4, 5])
    expect(pointsToNextWound(-2)).toBe(2)
    expect(pointsToNextWound(0)).toBe(3)
    expect(pointsToNextWound(5)).toBe(1)
  })

  test('a glancing blow drops the highest of the dice rolled with it, never an added one', () => {
    expect(glancingDrop(side([2, 5]))).toBe(1)
    expect(glancingDrop(side([4, 1, 6]))).toBe(0) // the 6 was added later
    expect(glancingDrop({ ...side([6, 3]), discarded: [true, false] })).toBe(1)
  })
})

describe('a player attacks an enemy', () => {
  test('hit vs Evasion, damage vs Physical resistance, tier effects live, wounds land when the GM finishes', async () => {
    const { s, mara, reopen } = await fight()
    s.spawnEnemies('wolf', 1, 'GM') // Evasion 8, Physical resistance 3, Health 3
    const wolf = s.bestiary.enemies[0]!
    expect(s.startAttack({ enemyId: wolf.id, charId: mara, hitAbility: 'agility', damageAbility: 'strength' }, 'GM')).not.toBeNull()
    const ch = s.currentChallenge()!
    expect(ch.charId).toBe(mara)
    expect(ch.attack).toMatchObject({ enemyName: 'Wolf 1', hitVs: 'evasion', damageVs: 'physical', hitValue: 8, damageValue: 3, evasionSpent: false })
    expect(s.challengeMath(ch).attack).toMatchObject({ hitTarget: 8, damageTarget: 3, tier: null })

    // Step 1: the hit alone.
    expect(s.rollChallenge(ch.id, 'Mara')).not.toBeNull()
    expect(ch.framing).not.toBeNull()
    expect(ch.resolution).toBeNull()
    expect(s.attackStep(ch)).toBe('hit')
    expect(s.rollsInPlay(ch)).toEqual(['framing'])
    expect(s.bestiary.evasionSpent('enemy', wolf.id)).toBe(true)
    // The damage can't be touched yet, and the GM can't finish a hit that landed.
    expect(s.adjustCustom(ch.id, mara, 'resolution', 1, 'Mara')).toBe(false)
    ch.framing = side([6, 5]) // a good hit
    expect(s.closeChallenge(ch.id, 'GM')).toBe(false)
    expect(s.adjustCustom(ch.id, mara, 'framing', 1, 'Mara')).toBe(true) // the hit can be altered
    expect(s.adjustCustom(ch.id, mara, 'framing', -1, 'Mara')).toBe(true)

    // Step 2: the damage — which locks the hit.
    expect(s.rollDamage(ch.id, mara, 'Mara')).not.toBeNull()
    expect(s.rollDamage(ch.id, mara, 'Mara')).toBeNull() // once
    expect(ch.attack!.critDie).not.toBeNull()
    expect(s.attackStep(ch)).toBe('damage')
    expect(s.rollsInPlay(ch)).toEqual(['resolution'])
    expect(s.adjustCustom(ch.id, mara, 'framing', 1, 'Mara')).toBe(false)
    expect(s.adjustCustom(ch.id, null, 'framing', 1, 'GM')).toBe(false)

    // Put the dice where the test wants them (the math is live, so it follows).
    const set = (hit: number[], damage: number[]) => {
      ch.framing = side(hit)
      ch.resolution = side(damage)
    }
    set([3, 4], [5, 2]) // hit 7 vs 8: −1 glancing → the 5 is discarded: damage 2 vs 3
    let m = s.challengeMath(ch).attack!
    expect([m.tier!.id, m.dropped, s.challengeMath(ch).resolution!.sum, m.wounds]).toEqual(['glancing', 0, 2, 0])
    set([6, 5], [5, 2]) // hit 11: +3 good → damage 7 + 1 = 8 vs 3: +5 → normal wound
    m = s.challengeMath(ch).attack!
    expect([m.tier!.id, s.challengeMath(ch).resolution!.sum, m.wounds]).toEqual(['good', 8, 2])
    set([1, 1], [6, 6]) // hit 2: −6 miss → no damage at all
    expect(s.challengeMath(ch).resolution).toBeNull()
    expect(s.challengeMath(ch).success).toBe(false)
    set([10, 7], [2, 2]) // hit 17: +9 critical → the extra die counts, no +2
    m = s.challengeMath(ch).attack!
    expect(m.tier!.id).toBe('critical')
    expect(s.challengeMath(ch).resolution!.sum).toBe(4 + ch.attack!.critDie!.value)

    set([6, 5], [5, 2]) // back to a good hit: 2 wounds
    expect(s.closeChallenge(ch.id, 'GM')).toBe(true)
    expect(ch.attack!.applied).toBe(2)
    expect(wolf.health).toBe(1)
    expect(reopen().bestiary.enemies[0]!.health).toBe(1)
  })

  test('a miss has no damage to roll: the GM finishes it straight away, nothing comes off', async () => {
    const { s, mara } = await fight()
    s.spawnEnemies('wolf', 1, 'GM')
    const wolf = s.bestiary.enemies[0]!
    s.startAttack({ enemyId: wolf.id, charId: mara, hitAbility: 'agility', damageAbility: 'strength' }, 'GM')
    const ch = s.currentChallenge()!
    s.rollChallenge(ch.id, 'Mara')
    ch.framing = side([1, 1]) // 2 vs 8: a miss
    expect(s.rollDamage(ch.id, mara, 'Mara')).toBeNull()
    expect(s.closeChallenge(ch.id, 'GM')).toBe(true)
    expect(ch.attack!.applied).toBe(0)
    expect(wolf.health).toBe(3)
  })

  test('the approach die lands with the hit and can be cashed in at either step — on whichever roll is open', async () => {
    const { s, mara } = await fight()
    s.spawnEnemies('ogre', 1, 'GM')
    const ogre = s.bestiary.enemies[0]!
    const start = () => {
      s.startAttack({ enemyId: ogre.id, charId: mara, hitAbility: 'agility', damageAbility: 'strength' }, 'GM')
      const ch = s.currentChallenge()!
      s.setChallengePlayer(ch.id, mara, 'exquisite', null, 'Mara')
      s.rollChallenge(ch.id, 'Mara')
      ch.framing = side([3, 3]) // not a miss against Evasion 4
      s.setApproachDie(ch.id, 6, 'GM') // Perfect choice: one die to its top face
      return ch
    }
    // Cashed in during the hit: only a hit die can take it.
    let ch = start()
    expect(ch.approachDie).toBe(6)
    expect(s.activateApproach(ch.id, mara, 'Mara')).toBe(true)
    expect(s.changeDieFace(ch.id, mara, 0, 'Mara', 'resolution')).toBe(false)
    expect(s.changeDieFace(ch.id, mara, 0, 'Mara', 'framing')).toBe(true)
    expect(ch.framing!.dice[0]).toBe(6)

    // Kept for the damage: the hit is locked by then, so only a damage die can take it.
    ch = start()
    expect(s.rollDamage(ch.id, mara, 'Mara')).not.toBeNull()
    ch.resolution = side([2, 2]) // neither die already on its top face
    expect(s.activateApproach(ch.id, mara, 'Mara')).toBe(true)
    expect(s.changeDieFace(ch.id, mara, 0, 'Mara', 'framing')).toBe(false)
    expect(s.changeDieFace(ch.id, mara, 1, 'Mara', 'resolution')).toBe(true)
    expect(ch.resolution!.dice[1]).toBe(6)
  })

  test('the second attack on the same enemy in a round goes against spent Evasion (0); a new round refreshes it', async () => {
    const { s, mara } = await fight()
    s.spawnEnemies('rat', 1, 'GM') // Evasion 10
    const rat = s.bestiary.enemies[0]!
    const attack = () => s.startAttack({ enemyId: rat.id, charId: mara, hitAbility: 'agility', damageAbility: 'strength' }, 'GM')
    attack()
    s.rollChallenge(s.currentChallenge()!.id, 'Mara')
    attack()
    expect(s.currentChallenge()!.attack!.evasionSpent).toBe(true)
    expect(s.challengeMath(s.currentChallenge()!).attack!.hitTarget).toBe(0)
    expect(s.nextCombatRound('GM')).toBe(true)
    expect(s.bestiary.round).toBe(2)
    attack()
    expect(s.challengeMath(s.currentChallenge()!).attack!.hitTarget).toBe(10)
  })

  test('the GM can point the rolls at other defences and the wounds at Mind; items add accuracy and damage', async () => {
    const { s, mara } = await fight()
    s.spawnEnemies('ghost', 1, 'GM') // Mental resistance 6
    const ghost = s.bestiary.enemies[0]!
    s.addItem(mara, 'Blessed blade', [{ target: 'attack_accuracy', delta: 2 }, { target: 'attack_damage', delta: 1 }], 'Mara')
    s.startAttack({ enemyId: ghost.id, charId: mara, hitAbility: 'intuition', damageAbility: 'resolve', hitVs: 'mental', damageVs: 'mental', pool: 'mind' }, 'GM')
    const ch = s.currentChallenge()!
    const m = s.challengeMath(ch).attack!
    expect([m.hitTarget, m.damageTarget, ch.attack!.pool]).toEqual([6, 6, 'mind'])
    expect([m.accuracy, m.weapon]).toEqual([2, 1])
  })
})

describe('an enemy attacks a player', () => {
  test('rolled and settled at once: wounds off the sheet, the log keeps every number, Evasion spent after', async () => {
    const { s, mara, reopen } = await fight()
    const char = s.characters.get(mara)!
    expect(s.statOf(char, 'health')!.current).toBe(4)
    s.spawnEnemies('ogre', 1, 'GM')
    const ogre = s.bestiary.enemies[0]!
    // Make it certain: a critical and a heavy blow.
    s.updateEnemy(ogre.id, 'hitBonus', '20', 'GM')
    s.updateEnemy(ogre.id, 'damageBonus', '20', 'GM')
    expect(s.enemyAttack(ogre.id, mara, {}, 'GM')).not.toBeNull()
    const a = s.enemyAttacks[0]!
    const m = enemyAttackMath(a)
    expect(m.tier.id).toBe('critical')
    expect(a.critDie).not.toBeNull()
    expect(a.damage!.dice).toHaveLength(2)
    expect(a.wounds).toBe(m.wounds)
    expect(a.wounds).toBeGreaterThan(4)
    expect([a.hitTarget, a.damageTarget, a.from, a.to]).toEqual([7, 5, 4, 0]) // a sheet pool stops at 0
    expect(s.statOf(char, 'health')!.current).toBe(0)

    // Its Evasion is spent for the rest of the round.
    s.enemyAttack(ogre.id, mara, {}, 'GM')
    expect(s.enemyAttacks[1]!.hitTarget).toBe(0)
    expect(s.enemyAttacks[1]!.evasionSpent).toBe(true)

    const again = reopen()
    expect(again.enemyAttacks).toHaveLength(2)
    expect(again.enemyAttacks[0]!.wounds).toBe(a.wounds)
    expect(again.statOf(again.characters.get(mara)!, 'health')!.current).toBe(0)
  })

  test('a miss rolls no damage; a glancing blow marks the dropped die', async () => {
    const { s, mara } = await fight()
    s.spawnEnemies('rat', 1, 'GM')
    const rat = s.bestiary.enemies[0]!
    s.updateEnemy(rat.id, 'hitBonus', '-20', 'GM')
    s.enemyAttack(rat.id, mara, {}, 'GM')
    expect(enemyAttackMath(s.enemyAttacks[0]!).tier.id).toBe('miss')
    expect(s.enemyAttacks[0]!.damage).toBeNull()
    expect(s.enemyAttacks[0]!.wounds).toBe(0)

    // Glancing: hit total exactly Evasion − 1 is impossible to force with dice, so check the rule
    // on the recorded shape instead: whenever it glances, exactly one damage die is discarded.
    s.updateEnemy(rat.id, 'hitBonus', '0', 'GM')
    for (let i = 0; i < 60; i++) {
      s.nextCombatRound('GM')
      s.enemyAttack(rat.id, mara, {}, 'GM')
      const a = s.enemyAttacks.at(-1)!
      if (enemyAttackMath(a).tier.id === 'glancing') expect(a.damage!.discarded!.filter(Boolean)).toHaveLength(1)
      else expect(a.damage?.discarded).toBeUndefined()
    }
  })
})
