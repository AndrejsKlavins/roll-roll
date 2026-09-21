import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadRules, type NumberField } from './rules'
import { rollChallengeSide, Session } from './session'

const RULES = `
name: Test
sections:
  - label: Abilities
    base: true
    fields:
      - { id: strength, label: Strength, type: number, min: 1, max: 5, default: 3 }
  - label: Condition
    fields:
      - { id: wounds, label: Wounds, type: track, max: 5 }
      - { id: notes, label: Notes, type: text }
derived:
  - { id: carry, label: Carry, formula: "strength * 2" }
  - { id: health, label: Health, formula: "strength + 2", pool: true }
rolls: []
`

const dirs: string[] = []
const opened: Session[] = []
afterEach(() => {
  for (const s of opened.splice(0)) s.close()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

async function setup(rulesText = RULES) {
  const dir = mkdtempSync(join(tmpdir(), 'roll-table-'))
  dirs.push(dir)
  writeFileSync(join(dir, 'rules.yaml'), rulesText)
  const rules = await loadRules(join(dir, 'rules.yaml'))
  const dbPath = join(dir, 'session.db')
  const open = () => {
    const session = new Session(rules, dbPath)
    opened.push(session)
    return session
  }
  return { rules, open }
}

describe('character stages', () => {
  test('draft edits are saved but not logged', async () => {
    const { open } = await setup()
    const s = open()
    const c = s.createCharacter('Mara')
    const logged = s.events.length
    expect(c.status).toBe('draft')
    s.adjustField(c.id, 'strength', 1, 'Mara')
    s.adjustField(c.id, 'strength', 1, 'Mara')
    s.setField(c.id, 'notes', 'brave', 'Mara')
    expect(s.events.length).toBe(logged)
    expect(s.valueOf(c, s.rules.fields.get('strength') as NumberField)).toBe(5)

    // Draft survives a restart.
    const reopened = open()
    const again = reopened.characters.get(c.id)!
    expect(again.status).toBe('draft')
    expect(again.values.strength).toBe(5)
    expect(again.values.notes).toBe('brave')
  })

  test('finishing locks base values; play changes are relative to base', async () => {
    const { open } = await setup()
    const s = open()
    const c = s.createCharacter('Mara')
    const strength = s.rules.fields.get('strength') as NumberField
    s.setField(c.id, 'strength', 4, 'Mara')
    expect(s.finalizeCharacter(c.id, 'Mara')).not.toBeNull()
    expect(s.finalizeCharacter(c.id, 'Mara')).toBeNull() // only once

    s.adjustField(c.id, 'strength', -1, 'Mara') // poisoned
    expect(s.valueOf(c, strength)).toBe(3)
    expect(s.baseOf(c, strength)).toBe(4)
    expect(s.scope(c.id).carry).toBe(6) // formulas use the current value

    // Base correction keeps the −1.
    s.adjustBase(c.id, 'strength', 1, 'GM')
    expect(s.baseOf(c, strength)).toBe(5)
    expect(s.valueOf(c, strength)).toBe(4)

    // Base stays within its declared range; current may still be buffed past it.
    expect(s.adjustBase(c.id, 'strength', 1, 'GM')).toBe(false)
    s.setField(c.id, 'strength', 7, 'Mara')
    expect(s.valueOf(c, strength)).toBe(7)

    // Everything replays identically after restart.
    const reopened = open()
    const again = reopened.characters.get(c.id)!
    expect(again.status).toBe('active')
    expect(reopened.baseOf(again, strength)).toBe(5)
    expect(reopened.valueOf(again, strength)).toBe(7)
  })

  test('undo covers base changes', async () => {
    const { open } = await setup()
    const s = open()
    const id = s.createCharacter('Mara').id
    s.finalizeCharacter(id, 'Mara')
    const strength = s.rules.fields.get('strength') as NumberField
    s.adjustField(id, 'strength', -1, 'Mara')
    s.adjustBase(id, 'strength', 1, 'Mara')
    s.undoLast(id, 'Mara')
    let c = s.characters.get(id)!
    expect(s.baseOf(c, strength)).toBe(3)
    expect(s.valueOf(c, strength)).toBe(2)
    s.undoLast(id, 'Mara')
    c = s.characters.get(id)!
    expect(s.valueOf(c, strength)).toBe(3)
  })

  test('draft changes cannot touch base; active base fields floor at their own min', async () => {
    const { open } = await setup()
    const s = open()
    const c = s.createCharacter('Mara')
    expect(s.adjustBase(c.id, 'strength', 1, 'Mara')).toBe(false)
    s.finalizeCharacter(c.id, 'Mara')
    s.setField(c.id, 'strength', -5, 'Mara')
    expect(s.valueOf(c, s.rules.fields.get('strength') as NumberField)).toBe(1) // field min is 1

    // A field with no declared min/max scales indefinitely, in play and as a base value.
    const { open: openUnbounded } = await setup(RULES.replace(
      '{ id: strength, label: Strength, type: number, min: 1, max: 5, default: 3 }',
      '{ id: strength, label: Strength, type: number, default: 3 }',
    ))
    const u = openUnbounded()
    const uc = u.createCharacter('Finn')
    u.finalizeCharacter(uc.id, 'Finn')
    u.setField(uc.id, 'strength', -5, 'Finn')
    expect(u.valueOf(uc, u.rules.fields.get('strength') as NumberField)).toBe(-5)
    u.setField(uc.id, 'strength', 42, 'Finn')
    expect(u.valueOf(uc, u.rules.fields.get('strength') as NumberField)).toBe(42)
    expect(u.adjustBase(uc.id, 'strength', 100, 'GM')).toBe(true)
  })
})

describe('calculated stats in play', () => {
  test('pools spend and restore within 0..max; damage survives a max change', async () => {
    const { open } = await setup()
    const s = open()
    const id = s.createCharacter('Mara').id
    const c = () => s.characters.get(id)!
    expect(s.adjustStat(id, 'health', -1, 'Mara')).toBe(false) // not while in creation
    s.finalizeCharacter(id, 'Mara')
    expect(s.statOf(c(), 'health')).toEqual({ normal: 5, current: 5 })
    expect(s.adjustStat(id, 'health', 1, 'Mara')).toBe(false) // already full
    s.adjustStat(id, 'health', -2, 'Mara')
    expect(s.statOf(c(), 'health')).toEqual({ normal: 5, current: 3 })
    s.setStat(id, 'health', -10, 'Mara')
    expect(s.statOf(c(), 'health')!.current).toBe(0)
    s.setStat(id, 'health', 3, 'Mara')

    s.adjustBase(id, 'strength', 1, 'GM') // max 5 → 6, still 2 damage
    expect(s.statOf(c(), 'health')).toEqual({ normal: 6, current: 4 })

    s.undoLast(id, 'GM') // undo base change
    s.undoLast(id, 'Mara') // undo set to 3 → back to 0
    expect(s.statOf(c(), 'health')).toEqual({ normal: 5, current: 0 })

    const reopened = open()
    expect(reopened.statOf(reopened.characters.get(id)!, 'health')).toEqual({ normal: 5, current: 0 })
  })

  test('regular stats take a modifier on top of the formula and can exceed it', async () => {
    const { open } = await setup()
    const s = open()
    const id = s.createCharacter('Mara').id
    s.finalizeCharacter(id, 'Mara')
    s.adjustStat(id, 'carry', 3, 'Mara')
    expect(s.statOf(s.characters.get(id)!, 'carry')).toEqual({ normal: 6, current: 9 })
    expect(s.scope(id).carry).toBe(6) // formulas keep using the formula result
    expect(s.events.at(-1)).toMatchObject({ type: 'stat_set', stat: 'carry', adj: 3, from: 6, to: 9 })
  })
})

const TRAINING_RULES = `
name: Test
training: { points_stat: skill_points, rank_costs: [4, 5, 6, 7, 8] }
sections:
  - label: Abilities
    base: true
    fields:
      - { id: knowledge, label: Knowledge, type: number, min: 1, max: 5, default: 3 }
  - label: Misc
    fields:
      - { id: level, label: Level, type: level }
      - { id: skill_points, label: Max skill points, type: derived, base: true, formula: "3 + knowledge" }
  - label: Skills
    trained: true
    fields:
      - { id: stealth, label: Stealth, type: number, min: 0, max: 5, default: 0 }
      - { id: theory, label: Theory, type: number, min: 0, max: 5, default: 0 }
rolls: []
`

describe('skill point training', () => {
  const stealth = (s: Session) => s.rules.fields.get('stealth') as NumberField

  test('ranks follow 4 / 9 / 15 / 22 / 30 points', async () => {
    const { open } = await setup(TRAINING_RULES)
    const s = open()
    expect([0, 3, 4, 8, 9, 14, 15, 21, 22, 29, 30].map((p) => s.rankOf(p))).toEqual([0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5])
  })

  test('finishing grants points; training spends them and sets the rank', async () => {
    const { open } = await setup(TRAINING_RULES)
    const s = open()
    const id = s.createCharacter('Mara').id
    const c = () => s.characters.get(id)!
    expect(s.train(id, 'stealth', 1, 'Mara')).toBe(false) // not in creation
    expect(s.setField(id, 'stealth', 3, 'Mara')).toBe(false) // skills aren't set directly
    s.finalizeCharacter(id, 'Mara')
    expect(s.availablePoints(c())).toBe(6)

    for (let i = 0; i < 5; i++) s.train(id, 'stealth', 1, 'Mara')
    expect(c().skillPoints.stealth).toBe(5)
    expect(s.baseOf(c(), stealth(s))).toBe(1)
    expect(s.availablePoints(c())).toBe(1)

    s.train(id, 'theory', 1, 'Mara')
    expect(s.availablePoints(c())).toBe(0)
    expect(s.train(id, 'stealth', 1, 'Mara')).toBe(false) // nothing left to spend

    s.train(id, 'stealth', -1, 'Mara') // correction: take one back
    expect(s.availablePoints(c())).toBe(1)
    s.undoLast(id, 'Mara')
    expect(c().skillPoints.stealth).toBe(5)
  })

  test('level ups use base Knowledge; GM grants; points stop at master', async () => {
    const { open } = await setup(TRAINING_RULES)
    const s = open()
    const id = s.createCharacter('Mara').id
    const c = () => s.characters.get(id)!
    s.finalizeCharacter(id, 'Mara') // +6
    s.adjustField(id, 'knowledge', 2, 'Mara') // temporary boost does not count
    s.levelUp(id, 'GM') // +6
    expect(c().level).toBe(2)
    s.adjustBase(id, 'knowledge', 1, 'GM') // base 4 → 7 per level
    s.levelUp(id, 'GM')
    expect(s.availablePoints(c())).toBe(19)
    s.grantPoints(id, 20, 'GM')
    for (let i = 0; i < 35; i++) s.train(id, 'stealth', 1, 'Mara')
    expect(c().skillPoints.stealth).toBe(30)
    expect(s.baseOf(c(), stealth(s))).toBe(5)
    expect(s.availablePoints(c())).toBe(9)

    // Temporary bonus on top of the trained rank.
    s.adjustField(id, 'stealth', 1, 'Mara')
    expect(s.valueOf(c(), stealth(s))).toBe(6)

    const reopened = open()
    const again = reopened.characters.get(id)!
    expect(reopened.availablePoints(again)).toBe(9)
    expect(again.level).toBe(3)
    expect(reopened.valueOf(again, stealth(reopened))).toBe(6)
  })

  test('level row is parsed; a mis-tapped level up can be undone', async () => {
    const { open } = await setup(TRAINING_RULES)
    const s = open()
    expect(s.rules.level).toMatchObject({ id: 'level', label: 'Level', type: 'level' })
    expect(s.rules.fields.has('level')).toBe(false)
    const id = s.createCharacter('Mara').id
    s.finalizeCharacter(id, 'Mara')
    s.levelUp(id, 'Mara')
    expect(s.characters.get(id)!.level).toBe(2)
    expect(s.availablePoints(s.characters.get(id)!)).toBe(12)
    s.undoLast(id, 'Mara')
    expect(s.characters.get(id)!.level).toBe(1)
    expect(s.availablePoints(s.characters.get(id)!)).toBe(6)
  })

  test('only rank-changing training shows in the change log', async () => {
    const { open } = await setup(TRAINING_RULES)
    const s = open()
    const id = s.createCharacter('Mara').id
    s.finalizeCharacter(id, 'Mara')
    const trainingEntries = () => s.recentChanges().filter((e) => e.type === 'skill_trained')

    for (let i = 0; i < 3; i++) s.train(id, 'stealth', 1, 'Mara') // 3 points: still untrained
    expect(s.events.filter((e) => e.type === 'skill_trained')).toHaveLength(3) // all still stored
    expect(trainingEntries()).toHaveLength(0)

    s.train(id, 'stealth', 1, 'Mara') // 4th point → novice
    expect(trainingEntries()).toMatchObject([{ from: 3, to: 4 }])

    s.train(id, 'stealth', -1, 'Mara') // back to untrained
    expect(trainingEntries()).toHaveLength(2)

    // Undoing a point that changed nothing stays out of the log too.
    s.train(id, 'stealth', 1, 'Mara') // novice again (logged)
    s.train(id, 'stealth', 1, 'Mara') // 5 points, still novice (not logged)
    const before = s.recentChanges().length
    s.undoLast(id, 'Mara')
    expect(s.recentChanges().length).toBe(before)
  })
})

describe('challenge dice', () => {
  test('face ids stay 1-6 while the values they count for are shifted by rank', () => {
    const faces = [2, 5]
    let i = 0
    const rng = () => faces[i++]!

    const average = rollChallengeSide(3, rng) // rank 3 → no shift
    expect(average).toEqual({ faces: [2, 5], dice: [2, 5], sum: 7 })

    i = 0
    const strong = rollChallengeSide(5, rng) // +2 on every face
    expect(strong).toEqual({ faces: [2, 5], dice: [4, 7], sum: 11 })

    i = 0
    const weak = rollChallengeSide(1, rng) // −2 on every face
    expect(weak).toEqual({ faces: [2, 5], dice: [0, 3], sum: 3 })

    // A strong character's "poor" (face 2) beats a weak character's "great" (face 5).
    expect(strong.dice[0]).toBeGreaterThan(weak.dice[1])
  })
})

const CHALLENGE_RULES = `
name: Test
sections:
  - label: Abilities
    base: true
    fields:
      - { id: strength, label: Strength, type: number, min: 1, max: 5, default: 3 }
      - { id: agility, label: Agility, type: number, min: 1, max: 5, default: 3 }
  - label: Reserves
    fields:
      - { id: stamina, label: Stamina, type: derived, pool: true, formula: "2" }
      - { id: willpower, label: Willpower, type: derived, pool: true, formula: "1" }
challenges:
  difficulties:
    - { id: easy, label: Easy, value: 4 }
  approaches:
    - { id: bold, label: Bold }
  exertion_sources: [stamina, willpower]
  faces:
    - { value: 1, label: horrible, color: "#c0392b" }
    - { value: 6, label: amazing, color: "#45a862" }
rolls: []
`

describe('challenge setup', () => {
  test('a challenge needs a description', async () => {
    const { open } = await setup(CHALLENGE_RULES)
    const s = open()
    const opts = {
      mainAbility: 'strength',
      supportAbility: 'agility',
      mainDifficulty: 9,
      supportDifficulty: 9,
      stakes: 'normal' as const,
    }
    expect(s.startChallenge({ ...opts, description: '   ' }, 'GM')).toBeNull()
    expect(s.challenges).toHaveLength(0)
    expect(s.startChallenge({ ...opts, description: '  Scale the wall  ' }, 'GM')).not.toBeNull()
    expect(s.currentChallenge()!.description).toBe('Scale the wall')
  })
})

describe('exertion', () => {
  async function rolledChallenge() {
    const { open } = await setup(CHALLENGE_RULES)
    const s = open()
    const id = s.createCharacter('Mara').id
    s.finalizeCharacter(id, 'Mara')
    s.startChallenge(
      {
        description: 'Scale the wall',
        mainAbility: 'strength',
        supportAbility: 'agility',
        mainDifficulty: 9,
        supportDifficulty: 9,
        stakes: 'normal',
      },
      'GM',
    )
    const ch = s.currentChallenge()!
    s.setChallengePlayer(ch.id, id, 'bold', null, 'GM')
    s.rollChallenge(ch.id, 'Mara')
    return { s, id, ch: s.currentChallenge()! }
  }

  test('burning a pool point yields exertion that can be added to a side', async () => {
    const { s, id, ch } = await rolledChallenge()
    const char = () => s.characters.get(id)!
    expect(s.availableExertion(ch)).toBe(0)
    expect(s.spendExertion(ch.id, id, 'main', 'Mara')).toBe(false) // nothing to spend yet

    expect(s.exert(ch.id, id, 'stamina', 'Mara')).toBe(true)
    expect(s.statOf(char(), 'stamina')).toEqual({ normal: 2, current: 1 })
    expect(s.availableExertion(ch)).toBe(1)

    const before = s.challengeOutcome(ch)!.main.sum
    s.spendExertion(ch.id, id, 'main', 'Mara')
    expect(s.challengeOutcome(s.currentChallenge()!)!.main.sum).toBe(before + 1)
    expect(s.availableExertion(s.currentChallenge()!)).toBe(0)
  })

  test('a pool at 0 cannot be exerted; rerolling spends exertion and replaces one die', async () => {
    const { s, id, ch } = await rolledChallenge()
    s.exert(ch.id, id, 'willpower', 'Mara') // willpower = 1
    expect(s.exert(ch.id, id, 'willpower', 'Mara')).toBe(false) // empty now
    expect(s.exert(ch.id, id, 'strength', 'Mara')).toBe(false) // not a listed pool

    const kept = s.currentChallenge()!.main!.dice[1]
    expect(s.rerollDie(ch.id, id, 'main', 0, 'Mara')).toBe(true)
    const after = s.currentChallenge()!.main!
    expect(after.dice[1]).toBe(kept)
    expect(after.sum).toBe(after.dice[0] + after.dice[1])
    expect(s.availableExertion(s.currentChallenge()!)).toBe(0)
    expect(s.rerollDie(ch.id, id, 'main', 0, 'Mara')).toBe(false) // nothing left
  })

  test('a closed challenge takes no more input', async () => {
    const { s, id, ch } = await rolledChallenge()
    expect(s.closeChallenge(ch.id, 'GM')).toBe(true)
    expect(s.currentChallenge()!.closed).toBe(true)
    expect(s.closeChallenge(ch.id, 'GM')).toBe(false)
    expect(s.exert(ch.id, id, 'stamina', 'Mara')).toBe(false)
    expect(s.rerollDie(ch.id, id, 'main', 0, 'Mara')).toBe(false)
  })
})
