import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadRules, type NumberField } from './rules'
import { rollChallengeSide, Session, sideSum } from './session'

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
    expect(strong.dice[0]!).toBeGreaterThan(weak.dice[1]!)
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
    - { id: stubborn, label: Stubborn, when: failure }
    - { id: fancy, label: Fancy, when: choice }
    - id: stoic
      label: Stoic
      when: failure
      effects:
        - { face: 1, kind: none }
        - { face: 2, kind: declare, label: Shrug it off }
        - { face: 3, kind: raise_face, dice: 2 }
        - { face: 4, kind: raise_face, dice: 2 }
        - { face: 5, kind: set_face, dice: 2, to_face: 3 }
        - { face: 6, kind: set_face, dice: 2, to_face: 3 }
    - id: tricky
      label: Tricky
      when: always
      effects:
        - { face: 1, kind: discard }
        - { face: 2, kind: none }
        - { face: 3, kind: reroll }
        - { face: 4, kind: extra_dice, dice: 1 }
        - { face: 5, kind: extra_dice, dice: 1 }
        - { face: 6, kind: extra_dice, dice: 2 }
  exertion_sources: [stamina, willpower]
  faces:
    - { value: 1, label: horrible, color: "#c0392b" }
    - { value: 2, label: poor,     color: "#d1683a" }
    - { value: 3, label: ok,       color: "#d6a648" }
    - { value: 4, label: good,     color: "#b3bf4f" }
    - { value: 5, label: great,    color: "#79b455" }
    - { value: 6, label: amazing,  color: "#45a862" }
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

/** Starts a fresh challenge for `id` and rolls it; any earlier one falls into history. */
function startAndRoll(s: Session, id: string, approach: string, difficulty: number) {
  s.startChallenge(
    {
      description: 'Scale the wall',
      mainAbility: 'strength',
      supportAbility: 'agility',
      mainDifficulty: difficulty,
      supportDifficulty: difficulty,
      stakes: 'normal',
    },
    'GM',
  )
  const ch = s.currentChallenge()!
  s.setChallengePlayer(ch.id, id, approach, null, 'GM')
  s.rollChallenge(ch.id, 'Mara')
  return s.currentChallenge()!
}

/** A challenge already rolled by Mara. Difficulty 9 is a coin flip; 2/30 force pass/fail. */
async function rolledChallenge(approach = 'bold', difficulty = 9) {
  const { open } = await setup(CHALLENGE_RULES)
  const s = open()
  const id = s.createCharacter('Mara').id
  s.finalizeCharacter(id, 'Mara')
  return { s, id, open, ch: startAndRoll(s, id, approach, difficulty) }
}

/**
 * The approach die is random, so to test one face's effect we keep rolling fresh challenges
 * until it turns up (1-in-6 each time; 300 tries makes a miss vanishingly unlikely).
 */
async function challengeWithFace(face: number, approach = 'tricky', difficulty = 9) {
  const { s, id, open } = await rolledChallenge(approach, difficulty)
  for (let i = 0; i < 300; i++) {
    if (s.currentChallenge()!.approachDie === face) return { s, id, open, ch: s.currentChallenge()! }
    startAndRoll(s, id, approach, difficulty)
  }
  throw new Error(`approach die never landed on ${face}`)
}

describe('exertion', () => {
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
    expect(after.sum).toBe(sideSum(after))
    expect(s.availableExertion(s.currentChallenge()!)).toBe(0)
    expect(s.rerollDie(ch.id, id, 'main', 0, 'Mara')).toBe(false) // nothing left
  })

  test('every reroll is counted on the die it replaced', async () => {
    const { s, id, ch } = await rolledChallenge()
    s.exert(ch.id, id, 'stamina', 'Mara') // stamina = 2 → two rerolls in hand
    s.exert(ch.id, id, 'stamina', 'Mara')
    expect(s.currentChallenge()!.main!.rerolled).toBeUndefined() // nothing rerolled yet

    s.rerollDie(ch.id, id, 'main', 0, 'Mara')
    expect(s.currentChallenge()!.main!.rerolled).toEqual([1, 0])
    s.rerollDie(ch.id, id, 'main', 0, 'Mara') // the same die again
    expect(s.currentChallenge()!.main!.rerolled).toEqual([2, 0])
    expect(s.currentChallenge()!.support!.rerolled).toBeUndefined() // other side untouched
    expect(s.availableExertion(s.currentChallenge()!)).toBe(0) // both exertions spent
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

describe('approach die', () => {
  test('rolling adds one plain d6 for the picked approach', async () => {
    const { s } = await rolledChallenge()
    const die = s.currentChallenge()!.approachDie!
    expect(die).toBeGreaterThanOrEqual(1)
    expect(die).toBeLessThanOrEqual(6)
  })

  test('an "always" approach is in effect as soon as it is rolled', async () => {
    const { s } = await rolledChallenge('bold')
    expect(s.approachState(s.currentChallenge()!)!.status).toBe('active')
  })

  test('a "failure" approach is in effect only while the roll fails', async () => {
    const failing = await rolledChallenge('stubborn', 30)
    expect(failing.s.approachState(failing.s.currentChallenge()!)!.status).toBe('active')

    const passing = await rolledChallenge('stubborn', 2)
    expect(passing.s.approachState(passing.s.currentChallenge()!)!.status).toBe('skipped')
  })

  test('a "choice" approach waits for the player to activate it', async () => {
    const { s, id, ch } = await rolledChallenge('fancy')
    expect(s.approachState(ch)!.status).toBe('ready')
    expect(s.activateApproach(ch.id, id, 'Mara')).toBe(true)
    expect(s.approachState(s.currentChallenge()!)!.status).toBe('active')
    expect(s.activateApproach(ch.id, id, 'Mara')).toBe(false) // only once
  })

  test('only the rolling player activates, and never on a closed or non-choice approach', async () => {
    const other = await rolledChallenge('fancy')
    expect(other.s.activateApproach(other.ch.id, 'nobody', 'Someone')).toBe(false)
    other.s.closeChallenge(other.ch.id, 'GM')
    expect(other.s.activateApproach(other.ch.id, other.id, 'Mara')).toBe(false)

    const always = await rolledChallenge('bold')
    expect(always.s.activateApproach(always.ch.id, always.id, 'Mara')).toBe(false)
  })

  test('an unrolled challenge, and one with no approach, have no die', async () => {
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
    s.setChallengePlayer(ch.id, id, null, null, 'GM')
    expect(s.approachState(ch)).toBeNull() // not rolled yet
    s.rollChallenge(ch.id, 'Mara')
    expect(s.currentChallenge()!.approachDie).toBeNull() // no approach picked
    expect(s.approachState(s.currentChallenge()!)).toBeNull()
  })
})

describe('approach die effects', () => {
  test('face 2 does nothing, so there is nothing to activate', async () => {
    const { s, id, ch } = await challengeWithFace(2)
    const state = s.approachState(ch)!
    expect(state.effect!.kind).toBe('none')
    expect(state.canActivate).toBe(false)
    expect(s.activateApproach(ch.id, id, 'Mara')).toBe(false)
  })

  test('face 1 discards a tapped die: it stops counting but stays on the side', async () => {
    const { s, id, ch } = await challengeWithFace(1)
    const before = s.currentChallenge()!.main!
    expect(s.discardDie(ch.id, id, 'main', 0, 'Mara')).toBe(false) // not activated yet
    expect(s.activateApproach(ch.id, id, 'Mara')).toBe(true)
    expect(s.approachState(s.currentChallenge()!)!.pending).toBe(true)

    expect(s.discardDie(ch.id, id, 'main', 0, 'Mara')).toBe(true)
    const after = s.currentChallenge()!.main!
    expect(after.dice).toEqual(before.dice) // the die is still shown
    expect(after.discarded).toEqual([true, false])
    expect(after.sum).toBe(after.dice[1]!)
    expect(s.approachState(s.currentChallenge()!)!.pending).toBe(false)

    // One pick only, and a discarded die can't be discarded again.
    expect(s.discardDie(ch.id, id, 'main', 1, 'Mara')).toBe(false)
  })

  test('face 3 rerolls a tapped die without spending exertion', async () => {
    const { s, id, ch } = await challengeWithFace(3)
    const kept = s.currentChallenge()!.main!.dice[1]
    s.activateApproach(ch.id, id, 'Mara')
    expect(s.approachReroll(ch.id, id, 'main', 0, 'Mara')).toBe(true)
    const after = s.currentChallenge()!
    expect(after.main!.dice[1]).toBe(kept)
    expect(after.main!.sum).toBe(sideSum(after.main!))
    expect(after.rerolls).toBe(0) // free: exertion is untouched
    expect(after.main!.rerolled).toEqual([1, 0]) // still counted on the die
    expect(s.availableExertion(after)).toBe(0)
    expect(s.approachReroll(ch.id, id, 'main', 0, 'Mara')).toBe(false) // one pick only
  })

  test('the pending effect only accepts its own kind of pick', async () => {
    const { s, id, ch } = await challengeWithFace(3)
    s.activateApproach(ch.id, id, 'Mara')
    expect(s.discardDie(ch.id, id, 'main', 0, 'Mara')).toBe(false)
    expect(s.addApproachDice(ch.id, id, 'main', 'Mara')).toBe(false)
    expect(s.approachReroll(ch.id, id, 'main', 5, 'Mara')).toBe(false) // no such die
  })

  test('faces 4 and 5 add one die to the chosen ability, face 6 adds two', async () => {
    for (const [face, extra] of [[4, 1], [5, 1], [6, 2]] as const) {
      const { s, id, ch } = await challengeWithFace(face)
      s.activateApproach(ch.id, id, 'Mara')
      expect(s.addApproachDice(ch.id, id, 'support', 'Mara')).toBe(true)
      const after = s.currentChallenge()!
      expect(after.support!.dice).toHaveLength(2 + extra)
      expect(after.support!.faces).toHaveLength(2 + extra)
      expect(after.support!.sum).toBe(sideSum(after.support!))
      expect(after.main!.dice).toHaveLength(2) // the other ability is untouched
      expect(s.challengeOutcome(after)!.support.sum).toBe(after.support!.sum)
      expect(s.addApproachDice(ch.id, id, 'main', 'Mara')).toBe(false) // one pick only
    }
  })

  test('extra dice take the ability rank shift, like the dice they join', async () => {
    const { s, id, ch } = await challengeWithFace(6)
    s.adjustBase(id, 'agility', 2, 'GM') // rank 5 → every face +2
    s.activateApproach(ch.id, id, 'Mara')
    s.addApproachDice(ch.id, id, 'support', 'Mara')
    const side = s.currentChallenge()!.support!
    for (const i of [2, 3]) expect(side.dice[i]).toBe(side.faces![i]! + 2)
  })

  test('effects survive a restart and never apply once the GM is done', async () => {
    const { s, id, ch, open } = await challengeWithFace(1)
    s.activateApproach(ch.id, id, 'Mara')
    s.discardDie(ch.id, id, 'main', 1, 'Mara')
    const sum = s.currentChallenge()!.main!.sum
    s.closeChallenge(ch.id, 'GM')
    expect(s.discardDie(ch.id, id, 'main', 0, 'Mara')).toBe(false)
    expect(s.activateApproach(ch.id, id, 'Mara')).toBe(false)

    const replayed = open().currentChallenge()!
    expect(replayed.main!.discarded).toEqual([false, true])
    expect(replayed.main!.sum).toBe(sum)
    expect(replayed.approachActivated).toBe(true)
    expect(replayed.approachPicksLeft).toBe(0)
  })
})

describe('unbreakable-style approach effects', () => {
  /** A failing challenge (difficulty 30) rolled with the `stoic` approach on the given face. */
  const failing = (face: number) => challengeWithFace(face, 'stoic', 30)

  test('nothing applies until the player activates it', async () => {
    const { s, id, ch } = await failing(3)
    const before = s.currentChallenge()!.main!.faces!.slice()
    expect(s.approachState(ch)!.canActivate).toBe(true)
    expect(s.approachState(ch)!.pending).toBe(false)
    expect(s.changeDieFace(ch.id, id, 'main', 0, 'Mara')).toBe(false) // not activated yet
    expect(s.currentChallenge()!.main!.faces).toEqual(before)

    s.activateApproach(ch.id, id, 'Mara')
    expect(s.approachState(s.currentChallenge()!)!.picksLeft).toBe(2)
  })

  test('a blank face offers no button; a declared ruling asks for nothing', async () => {
    const blank = await failing(1)
    expect(blank.s.approachState(blank.ch)!.canActivate).toBe(false)
    expect(blank.s.activateApproach(blank.ch.id, blank.id, 'Mara')).toBe(false)

    const ruling = await failing(2)
    expect(ruling.s.approachState(ruling.ch)!.canActivate).toBe(true)
    expect(ruling.s.activateApproach(ruling.ch.id, ruling.id, 'Mara')).toBe(true)
    const after = ruling.s.approachState(ruling.s.currentChallenge()!)!
    expect(after.status).toBe('active')
    expect(after.pending).toBe(false) // no dice to pick
  })

  test('raising moves two dice one face up and marks them', async () => {
    const { s, id, ch } = await failing(3)
    s.activateApproach(ch.id, id, 'Mara')
    const before = s.currentChallenge()!.main!.faces!.slice()

    expect(s.changeDieFace(ch.id, id, 'main', 0, 'Mara')).toBe(true)
    expect(s.approachState(s.currentChallenge()!)!.picksLeft).toBe(1)
    expect(s.changeDieFace(ch.id, id, 'main', 0, 'Mara')).toBe(false) // never the same die twice
    expect(s.changeDieFace(ch.id, id, 'support', 1, 'Mara')).toBe(true)

    const done = s.currentChallenge()!
    const raise = (was: number) => Math.min(6, was + 1)
    expect(done.main!.faces![0]).toBe(raise(before[0]!))
    expect(done.main!.dice[0]).toBe(done.main!.faces![0]! + (done.main!.dice[1]! - done.main!.faces![1]!))
    expect(done.main!.sum).toBe(sideSum(done.main!))
    // A die that was already on the top face cannot move, so it carries no marker.
    expect(done.main!.changed![0]).toBe(before[0] === 6 ? null : 'raised')
    expect(s.approachState(done)!.pending).toBe(false)
    expect(s.changeDieFace(ch.id, id, 'main', 1, 'Mara')).toBe(false) // both picks spent
  })

  test('squashing sets two dice to the configured face, up or down', async () => {
    const { s, id, ch } = await failing(5)
    s.activateApproach(ch.id, id, 'Mara')
    const before = s.currentChallenge()!.main!.faces!.slice()
    s.changeDieFace(ch.id, id, 'main', 0, 'Mara')
    s.changeDieFace(ch.id, id, 'main', 1, 'Mara')

    const done = s.currentChallenge()!.main!
    expect(done.faces).toEqual([3, 3])
    expect(done.changed).toEqual([before[0] === 3 ? null : 'squashed', before[1] === 3 ? null : 'squashed'])
    expect(done.sum).toBe(sideSum(done))
  })

  test('an activated die stays active even after the roll turns into a success', async () => {
    // Look for a failing roll that a point or two of exertion can turn into a success.
    const { s, id } = await rolledChallenge('stoic', 9)
    let ch = s.currentChallenge()!
    const shortBy = (c: typeof ch) => {
      const o = s.challengeOutcome(c)!
      return Math.max(0, -o.main.difference) + Math.max(0, -o.support.difference)
    }
    for (let i = 0; i < 300 && !(shortBy(ch) > 0 && shortBy(ch) <= 2 && s.approachState(ch)?.canActivate); i++) {
      ch = startAndRoll(s, id, 'stoic', 9)
    }
    expect(s.approachState(ch)!.status).toBe('active') // failing, so the button is offered
    s.activateApproach(ch.id, id, 'Mara')

    // Close the gap (stamina 2 + willpower 1 covers the 2 points this roll can be short).
    while (!s.challengeOutcome(s.currentChallenge()!)!.success) {
      if (!s.exert(ch.id, id, 'stamina', 'Mara')) s.exert(ch.id, id, 'willpower', 'Mara')
      const o = s.challengeOutcome(s.currentChallenge()!)!
      s.spendExertion(ch.id, id, o.main.success ? 'support' : 'main', 'Mara')
    }
    // Succeeding now would normally skip a `when: failure` die; activation holds it in place.
    expect(s.approachState(s.currentChallenge()!)!.status).toBe('active')
  })

  test('a succeeding roll offers nothing at all', async () => {
    const { s, id, ch } = await challengeWithFace(5, 'stoic', 2) // target 2: always a success
    const state = s.approachState(ch)!
    expect(state.status).toBe('skipped')
    expect(state.canActivate).toBe(false)
    expect(s.activateApproach(ch.id, id, 'Mara')).toBe(false)
  })

  test('picks and markers survive a restart', async () => {
    const { s, id, ch, open } = await failing(5)
    s.activateApproach(ch.id, id, 'Mara')
    s.changeDieFace(ch.id, id, 'main', 0, 'Mara')

    const replayed = open().currentChallenge()!
    expect(replayed.main!.faces![0]).toBe(3)
    expect(replayed.approachPicksLeft).toBe(1)
    expect(replayed.approachPicked).toEqual(['main:0'])
    expect(replayed.main!.sum).toBe(sideSum(replayed.main!))
  })
})
