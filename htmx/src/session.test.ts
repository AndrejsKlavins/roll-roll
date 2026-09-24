import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { framingRung, loadRules, type NumberField } from './rules'
import { MAX_CIRCUMSTANCE, outcomeFor, pointsToImprove, rollChallengeSide, Session, sideSum, type Challenge } from './session'

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
  - label: Skills
    base: true
    fields:
      - { id: pts, label: Points, type: derived, formula: "6" }
      - { id: athletics, label: Athletics, type: number, trained: true }
training:
  points_stat: pts
  rank_costs: [1, 2, 3]
challenges:
  difficulties:
    - { id: easy, label: Easy, value: 4 }
  framing:
    ladder:
      - { from: -9, bonus: -6, degrees: -1, label: Critical disadvantage }
      - { from: -8, bonus: -3, degrees: -1, label: Big disadvantage }
      - { from: -5, bonus: -1, degrees: -1, label: Disadvantage }
      - { from: -2, bonus: -1, label: Slightly off }
      - { from: 0,  label: Even }
      - { from: 3,  bonus: 1, label: Advantage }
      - { from: 6,  bonus: 3, label: Big advantage }
      - { from: 9,  bonus: 6, label: Critical advantage }
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
    - id: precise
      label: Precise
      when: choice
      effects:
        - { face: 1, kind: none }
        - { face: 2, kind: lower_raise }
        - { face: 3, kind: match_highest }
        - { face: 4, kind: match_highest }
        - { face: 5, kind: discard_double }
        - { face: 6, kind: discard_double }
    - id: canny
      label: Canny
      when: choice
      effects:
        - { face: 1, kind: lower_face }
        - { face: 2, kind: max_face }
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
  test('one difficulty covers the whole challenge; the name is optional', async () => {
    const { open } = await setup(CHALLENGE_RULES)
    const s = open()
    const opts = {
      framingAbility: 'strength',
      resolutionAbility: 'agility',
      difficulty: 9,
      stakes: 'normal' as const,
    }
    expect(s.startChallenge({ ...opts, resolutionAbility: 'nonsense' }, 'GM')).toBeNull()
    expect(s.startChallenge({ ...opts, framingAbility: 'nonsense' }, 'GM')).toBeNull()
    expect(s.challenges).toHaveLength(0)

    expect(s.startChallenge({ ...opts, description: '   ' }, 'GM')).not.toBeNull() // a name is optional
    expect(s.currentChallenge()!.description).toBe('')

    expect(s.startChallenge({ ...opts, description: '  Scale the wall  ' }, 'GM')).not.toBeNull()
    const ch = s.currentChallenge()!
    expect(ch.description).toBe('Scale the wall')
    expect(ch.difficulty).toBe(9)
    expect(s.challengeMath(ch).target).toBe(9) // nothing has moved it yet
  })

  test('the framing ability may be skipped entirely', async () => {
    const { open } = await setup(CHALLENGE_RULES)
    const s = open()
    // Both an omitted and an empty framing ability mean "resolution only".
    expect(
      s.startChallenge({ resolutionAbility: 'agility', difficulty: 9, stakes: 'normal' }, 'GM'),
    ).not.toBeNull()
    expect(s.currentChallenge()!.framingAbility).toBeNull()
    expect(
      s.startChallenge({ framingAbility: '', resolutionAbility: 'agility', difficulty: 9, stakes: 'normal' }, 'GM'),
    ).not.toBeNull()
    expect(s.currentChallenge()!.framingAbility).toBeNull()
  })

  test('the declared skill is a bonus on each result, not a cut in the difficulty', async () => {
    const { open } = await setup(CHALLENGE_RULES)
    const s = open()
    const id = s.createCharacter('Mara').id
    s.finalizeCharacter(id, 'Mara')
    s.train(id, 'athletics', 3, 'Mara') // rank_costs [1, 2, 3] → 3 points is rank 2
    expect(s.rankOf(3)).toBe(2)

    const ch = startChallenge(s, 10)
    s.setChallengePlayer(ch.id, id, 'bold', 'athletics', 'GM')
    const before = s.challengeMath(s.currentChallenge()!)
    expect(before.skillBonus).toBe(2)
    expect(before.skillLabel).toBe('Athletics')
    expect(before.target).toBe(10) // the difficulty is untouched (user decision)

    s.rollChallenge(ch.id, 'Mara')
    const rolled = s.currentChallenge()!
    const math = s.challengeMath(rolled)
    expect(math.framing!.target).toBe(10)
    expect(math.framing!.sum).toBe(rolled.framing!.sum + 2) // it rides on the rolled result
    // …and on the resolution too, alongside whatever the framing rung added to it.
    expect(math.resolution!.sum).toBe(rolled.resolution!.sum + 2 + math.rungBonus)
  })

  test('the circumstance moves the difficulty, and the skill still rides on the rolls', async () => {
    const { open } = await setup(CHALLENGE_RULES)
    const s = open()
    const id = s.createCharacter('Mara').id
    s.finalizeCharacter(id, 'Mara')
    s.train(id, 'athletics', 3, 'Mara')
    const ch = startChallenge(s, 10)
    s.setChallengePlayer(ch.id, id, 'bold', 'athletics', 'GM')
    expect(s.adjustCircumstance(ch.id, 3, 'GM')).toBe(true)
    const math = s.challengeMath(s.currentChallenge()!)
    expect([math.difficulty, math.circumstance, math.target, math.skillBonus]).toEqual([10, 3, 13, 2])
  })

  test('nothing declared before the dice can be changed after them', async () => {
    const { s, id, ch } = await rolledChallenge('bold')
    expect(s.setChallengePlayer(ch.id, id, 'fancy', null, 'GM')).toBeNull()
    expect(s.currentChallenge()!.approach).toBe('bold')
  })
})

/** Starts a fresh challenge; any earlier one falls into history. */
function startChallenge(s: Session, difficulty: number, framingAbility: string | null = 'strength') {
  s.startChallenge(
    {
      description: 'Scale the wall',
      framingAbility,
      resolutionAbility: 'agility',
      difficulty,
      stakes: 'normal',
    },
    'GM',
  )
  return s.currentChallenge()!
}

/** Starts a challenge for `id` and rolls both checks (the one roll that lands them together). */
function startAndRoll(s: Session, id: string, approach: string | null, difficulty: number) {
  const ch = startChallenge(s, difficulty)
  s.setChallengePlayer(ch.id, id, approach, null, 'GM')
  s.rollChallenge(ch.id, 'Mara')
  return s.currentChallenge()!
}

/** A finished character with a challenge waiting to be rolled. */
async function readyChallenge(approach: string | null = 'bold', difficulty = 9, framingAbility: string | null = 'strength') {
  const { open } = await setup(CHALLENGE_RULES)
  const s = open()
  const id = s.createCharacter('Mara').id
  s.finalizeCharacter(id, 'Mara')
  const ch = startChallenge(s, difficulty, framingAbility)
  s.setChallengePlayer(ch.id, id, approach, null, 'GM')
  return { s, id, open, ch: s.currentChallenge()! }
}

/** A challenge Mara has rolled. Difficulty 9 is a coin flip; 2/30 force pass/fail. */
async function rolledChallenge(approach: string | null = 'bold', difficulty = 9, framingAbility: string | null = 'strength') {
  const ready = await readyChallenge(approach, difficulty, framingAbility)
  ready.s.rollChallenge(ready.ch.id, 'Mara')
  return { ...ready, ch: ready.s.currentChallenge()! }
}

/**
 * The approach die is random, so to test one face's effect we keep rolling fresh challenges
 * until it turns up (1-in-6 each time; 300 tries makes a miss vanishingly unlikely).
 */
async function challengeWithFace(
  face: number,
  approach = 'tricky',
  difficulty = 9,
  /** An extra condition the challenge has to meet (e.g. a failing resolution). */
  want: (s: Session, ch: Challenge) => boolean = () => true,
) {
  const { s, id, open } = await rolledChallenge(approach, difficulty)
  for (let i = 0; i < 600; i++) {
    const ch = s.currentChallenge()!
    if (ch.approachDie === face && want(s, ch)) return { s, id, open, ch }
    startAndRoll(s, id, approach, difficulty)
  }
  throw new Error(`approach die never landed on ${face}`)
}

/**
 * The same thing without the loop: roll, then force the die onto `face` with the GM debug tool.
 * Preferred for the two-step effects, whose steps are easier to read when the face is certain.
 */
async function challengeOnFace(face: number, approach = 'precise', difficulty = 9) {
  const { s, id, open, ch } = await rolledChallenge(approach, difficulty)
  if (!s.setApproachDie(ch.id, face, 'GM')) throw new Error(`could not set the approach die to ${face}`)
  return { s, id, open, ch: s.currentChallenge()! }
}

/** An exertion reroll as the board does it: choose "Reroll a die", then tap the die. */
const reroll = (s: Session, chId: string, id: string, roll: 'framing' | 'resolution', index: number, by: string) => {
  s.setExertionReroll(chId, id, true, by) // refused (harmlessly) when already chosen or not allowed
  return s.rerollDie(chId, id, roll, index, by)
}

/** Faces and values of one of the two rolls, for before/after comparisons. */
const snapshot = (s: Session, roll: 'framing' | 'resolution' = 'resolution') => {
  const rolled = s.currentChallenge()![roll]!
  return { faces: [...rolled.faces!], dice: [...rolled.dice], sum: rolled.sum }
}

/**
 * Rolls challenge after challenge at `difficulty` until the framing margin lands on the rung
 * starting at `from`. The dice are random, so the difficulty is what steers it: two d6 at rank 3
 * land 2..12, so a difficulty of 3 can reach +9 and one of 12 can reach −9.
 */
function rollAtRung(s: Session, id: string, from: number, difficulty: number) {
  for (let i = 0; i < 800; i++) {
    const ch = startAndRoll(s, id, 'bold', difficulty)
    if (s.challengeMath(ch).rung!.from === from) return ch
  }
  throw new Error(`never framed onto the rung at ${from} (difficulty ${difficulty})`)
}

describe('the framing ladder', () => {
  test('the margin picks the rung it reaches, and the bottom rung catches the rest', async () => {
    const { rules } = await setup(CHALLENGE_RULES)
    const ladder = rules.challenges.framing
    const from = (margin: number) => framingRung(ladder, margin)!.from
    // The GM's table, band by band.
    expect([from(-30), from(-9)]).toEqual([-9, -9])
    expect([from(-8), from(-6)]).toEqual([-8, -8])
    expect([from(-5), from(-3)]).toEqual([-5, -5])
    expect([from(-2), from(-1)]).toEqual([-2, -2])
    expect([from(0), from(1), from(2)]).toEqual([0, 0, 0])
    expect([from(3), from(5)]).toEqual([3, 3])
    expect([from(6), from(8)]).toEqual([6, 6])
    expect([from(9), from(30)]).toEqual([9, 9])
  })

  test('each rung carries the resolution bonus and complication the ladder gives it', async () => {
    const { rules } = await setup(CHALLENGE_RULES)
    const rung = (from: number) => rules.challenges.framing.rungs.find((r) => r.from === from)!
    expect([rung(-9).resolutionBonus, rung(-9).degrees]).toEqual([-6, -1])
    expect([rung(-8).resolutionBonus, rung(-8).degrees]).toEqual([-3, -1])
    expect([rung(-5).resolutionBonus, rung(-5).degrees]).toEqual([-1, -1])
    expect([rung(-2).resolutionBonus, rung(-2).degrees]).toEqual([-1, 0]) // −1 bonus, no complication
    expect([rung(0).resolutionBonus, rung(0).degrees]).toEqual([0, 0])
    expect([rung(3).resolutionBonus, rung(3).degrees]).toEqual([1, 0])
    expect([rung(6).resolutionBonus, rung(6).degrees]).toEqual([3, 0])
    expect([rung(9).resolutionBonus, rung(9).degrees]).toEqual([6, 0])
  })
})

describe('pointsToImprove', () => {
  test('low stakes: only a bare success is ever reachable', () => {
    expect(pointsToImprove(-5, 'low')).toBe(5)
    expect(pointsToImprove(-1, 'low')).toBe(1)
    expect(pointsToImprove(0, 'low')).toBeNull() // already succeeding, and low grants no degree
    expect(pointsToImprove(5, 'low')).toBeNull()
  })

  test('normal stakes: a deep complication eases before it reaches plain success', () => {
    expect(pointsToImprove(-5, 'normal')).toBe(3) // −5 → −2 sheds the complication first
    expect(pointsToImprove(-3, 'normal')).toBe(1) // −3 → −2, same
    expect(pointsToImprove(-2, 'normal')).toBe(2) // no complication left; only success is closer
    expect(pointsToImprove(-1, 'normal')).toBe(1)
    expect(pointsToImprove(0, 'normal')).toBe(3) // succeeding, short of the one boon tier
    expect(pointsToImprove(2, 'normal')).toBe(1)
    expect(pointsToImprove(3, 'normal')).toBeNull() // already at normal's one tier
    expect(pointsToImprove(9, 'normal')).toBeNull()
  })

  test('high stakes: degrees truncate toward zero, so the middle tier is five points wide', () => {
    expect(pointsToImprove(0, 'high')).toBe(3)
    expect(pointsToImprove(1, 'high')).toBe(2)
    expect(pointsToImprove(2, 'high')).toBe(1)
    expect(pointsToImprove(3, 'high')).toBe(3) // on the boundary already — next tier is 3 more
    expect(pointsToImprove(-1, 'high')).toBe(1) // within the wide 0 tier — success is closer
    expect(pointsToImprove(-2, 'high')).toBe(2)
    expect(pointsToImprove(-4, 'high')).toBe(2) // −4 → −2 sheds the complication before success
    expect(pointsToImprove(-8, 'high')).toBe(3) // −8 → −5, into the next-lighter complication
    expect(pointsToImprove(-11, 'high')).toBe(3) // −11 → −8, likewise
    // General invariant: every step short of the answer changes nothing; the answer itself
    // either reaches success (if it wasn't already) or bumps the degree count.
    for (const diff of [-14, -11, -8, -6, -5, -3, -2, -1, 0, 1, 4, 7, 10]) {
      const needed = pointsToImprove(diff, 'high')!
      const before = outcomeFor(diff, 0, 'high')
      const at = outcomeFor(diff + needed, 0, 'high')
      expect(at.success && !before.success ? true : at.degrees > before.degrees).toBe(true)
      for (let step = 1; step < needed; step++) {
        const mid = outcomeFor(diff + step, 0, 'high')
        expect(mid.success && !before.success ? true : mid.degrees > before.degrees).toBe(false)
      }
    }
  })
})

describe('framing sets up the resolution', () => {
  test('both checks land together, in one event', async () => {
    const { s, ch } = await readyChallenge('bold', 9)
    expect(s.challengePhase(ch)).toBe('setup')
    expect(ch.framing).toBeNull()
    expect(ch.resolution).toBeNull()

    expect(s.rollChallenge(ch.id, 'Mara')).not.toBeNull()
    const rolled = s.currentChallenge()!
    expect(s.challengePhase(rolled)).toBe('rolled')
    expect(rolled.framing!.dice).toHaveLength(2)
    expect(rolled.resolution!.dice).toHaveLength(2)
    expect(s.rollChallenge(ch.id, 'Mara')).toBeNull() // once only

    const math = s.challengeMath(rolled)
    expect(math.framing!.target).toBe(9)
    expect(math.resolution!.target).toBe(9) // the rung buffs the roll, not the target
    expect(math.success).toBe(math.resolution!.success)
  })

  test('with no framing ability there is no framing roll and no rung', async () => {
    const { s, ch } = await rolledChallenge('bold', 9, null)
    expect(ch.framingAbility).toBeNull()
    expect(ch.framing).toBeNull()
    expect(ch.resolution!.dice).toHaveLength(2)
    const math = s.challengeMath(ch)
    expect(math.framing).toBeNull()
    expect(math.rung).toBeNull()
    expect(math.rungBonus).toBe(0)
    expect(math.resolution!.target).toBe(math.target) // nothing to move it
    expect(math.degrees).toBe(math.resolution!.degrees)
  })

  test('a rung buffs the resolution roll and may add a complication', async () => {
    const { s, id } = await rolledChallenge('bold', 12)
    const badCh = rollAtRung(s, id, -8, 12)
    const bad = s.challengeMath(badCh)
    expect(bad.rungBonus).toBe(-3)
    expect(bad.resolution!.target).toBe(bad.target) // the target itself never moves
    expect(bad.resolution!.sum).toBe(badCh.resolution!.sum + bad.skillBonus + badCh.exertionResolution + bad.rungBonus)
    expect(bad.degrees).toBe(bad.resolution!.degrees - 1) // …and the complication

    const worstCh = rollAtRung(s, id, -9, 12)
    const worst = s.challengeMath(worstCh)
    expect(worst.rungBonus).toBe(-6)
    expect(worst.degrees).toBe(worst.resolution!.degrees - 1)
  })

  test('the narrow −1/−2 rung hurts the roll without a complication', async () => {
    const { s, id } = await rolledChallenge('bold', 9)
    const math = s.challengeMath(rollAtRung(s, id, -2, 9))
    expect(math.rungBonus).toBe(-1)
    expect(math.degrees).toBe(math.resolution!.degrees) // no complication on this rung
  })

  test('an advantage buffs the resolution roll', async () => {
    const { s, id } = await rolledChallenge('bold', 3)
    const good = s.challengeMath(rollAtRung(s, id, 6, 3))
    expect(good.rungBonus).toBe(3)
    expect(good.resolution!.target).toBe(good.target) // the target itself never moves
    expect(good.degrees).toBe(good.resolution!.degrees)

    const best = s.challengeMath(rollAtRung(s, id, 9, 3))
    expect(best.rungBonus).toBe(6)
  })

  test('an even framing changes nothing', async () => {
    const { s, id } = await rolledChallenge('bold', 9)
    const math = s.challengeMath(rollAtRung(s, id, 0, 9))
    expect(math.rungBonus).toBe(0)
    expect(math.resolution!.target).toBe(math.target)
    expect(math.degrees).toBe(math.resolution!.degrees)
  })

  test("the resolution's bonus is recalculated on the fly when the framing moves", async () => {
    // Exertion on the framing is spent after both rolls are already on the table, so the rung —
    // and with it the resolution's bonus and its complication — has to follow it live.
    const { s, id } = await rolledChallenge('bold', 9)
    for (let i = 0; i < 400; i++) {
      const ch = s.currentChallenge()!
      const before = s.challengeMath(ch)
      // A framing sitting one point under a rung boundary: one exertion lifts it over.
      const next = s.rules.challenges.framing.rungs.find((r) => r.from === before.framing!.difference + 1)
      if (next && before.rung!.resolutionBonus !== next.resolutionBonus) {
        s.exert(ch.id, id, 'stamina', 'Mara')
        expect(s.spendExertion(ch.id, id, 'framing', 'Mara')).toBe(true)
        const rolled = s.currentChallenge()!
        const after = s.challengeMath(rolled)
        expect(after.rung!.from).toBe(next.from)
        expect(after.rungBonus).toBe(next.resolutionBonus)
        // The resolution's own dice never moved, and neither did the target — only the bonus
        // added on top of them.
        expect(rolled.resolution!.sum).toBe(ch.resolution!.sum)
        expect(after.resolution!.target).toBe(before.resolution!.target)
        expect(after.resolution!.sum).not.toBe(before.resolution!.sum)
        return
      }
      startAndRoll(s, id, 'bold', 9)
    }
    throw new Error('never rolled a framing one point under a rung boundary')
  })

  test('the roll, the skill and the circumstance survive a reopen', async () => {
    const { open } = await setup(CHALLENGE_RULES)
    const s = open()
    const id = s.createCharacter('Mara').id
    s.finalizeCharacter(id, 'Mara')
    s.train(id, 'athletics', 3, 'Mara')
    const ch = startChallenge(s, 12)
    s.setChallengePlayer(ch.id, id, 'bold', 'athletics', 'GM')
    s.rollChallenge(ch.id, 'Mara')
    s.adjustCircumstance(ch.id, 1, 'GM')
    const was = s.currentChallenge()!

    const reopened = open()
    const replayed = reopened.currentChallenge()!
    expect(replayed.framing).toEqual(was.framing)
    expect(replayed.resolution).toEqual(was.resolution)
    expect(replayed.circumstance).toBe(1)
    expect(replayed.skill).toBe('athletics')
    const math = reopened.challengeMath(replayed)
    expect(math.target).toBe(13) // 12 + 1; the skill is not in here
    expect(math.skillBonus).toBe(2)
  })
})

describe('exertion', () => {
  test('burning a pool point yields exertion that can be put on either roll', async () => {
    const { s, id, ch } = await rolledChallenge()
    const char = () => s.characters.get(id)!
    expect(s.availableExertion(ch)).toBe(0)
    expect(s.spendExertion(ch.id, id, 'resolution', 'Mara')).toBe(false) // nothing to spend yet

    expect(s.exert(ch.id, id, 'stamina', 'Mara')).toBe(true)
    expect(s.statOf(char(), 'stamina')).toEqual({ normal: 2, current: 1 })
    expect(s.availableExertion(ch)).toBe(1)

    const before = s.challengeMath(ch)
    s.spendExertion(ch.id, id, 'resolution', 'Mara')
    const after = s.challengeMath(s.currentChallenge()!)
    expect(after.resolution!.sum).toBe(before.resolution!.sum + 1)
    expect(after.framing!.sum).toBe(before.framing!.sum) // the other roll is untouched
    expect(s.availableExertion(s.currentChallenge()!)).toBe(0)
  })

  test('a challenge with no framing roll refuses exertion on one', async () => {
    const { s, id, ch } = await rolledChallenge('bold', 9, null)
    s.exert(ch.id, id, 'stamina', 'Mara')
    expect(s.spendExertion(ch.id, id, 'framing', 'Mara')).toBe(false)
    expect(s.spendExertion(ch.id, id, 'resolution', 'Mara')).toBe(true)
  })

  test('a pool at 0 cannot be exerted; rerolling spends exertion and replaces one die', async () => {
    const { s, id, ch } = await rolledChallenge()
    s.exert(ch.id, id, 'willpower', 'Mara') // willpower = 1
    expect(s.exert(ch.id, id, 'willpower', 'Mara')).toBe(false) // empty now
    expect(s.exert(ch.id, id, 'strength', 'Mara')).toBe(false) // not a listed pool

    const kept = s.currentChallenge()!.resolution!.dice[1]
    expect(reroll(s, ch.id, id, 'resolution', 0, 'Mara')).toBe(true)
    const after = s.currentChallenge()!.resolution!
    expect(after.dice[1]).toBe(kept)
    expect(after.sum).toBe(sideSum(after))
    expect(s.availableExertion(s.currentChallenge()!)).toBe(0)
    expect(reroll(s, ch.id, id, 'resolution', 0, 'Mara')).toBe(false) // nothing left
  })

  test('the framing roll can be rerolled too, and its bonus to the resolution follows it', async () => {
    const { s, id, ch } = await rolledChallenge()
    s.exert(ch.id, id, 'stamina', 'Mara')
    const before = s.challengeMath(ch)
    expect(reroll(s, ch.id, id, 'framing', 0, 'Mara')).toBe(true)
    const rolled = s.currentChallenge()!
    const after = s.challengeMath(rolled)
    expect(rolled.framing!.rerolled).toEqual([1, 0])
    expect(rolled.resolution!.dice).toEqual(ch.resolution!.dice) // its dice are untouched
    expect(after.resolution!.target).toBe(before.resolution!.target) // and neither is its target
    // …but the bonus added on top of it is live, following the framing's new rung.
    expect(after.resolution!.sum).toBe(rolled.resolution!.sum + after.skillBonus + rolled.exertionResolution + after.rungBonus)
  })

  test('every reroll is counted on the die it replaced', async () => {
    const { s, id, ch } = await rolledChallenge()
    s.exert(ch.id, id, 'stamina', 'Mara') // stamina = 2 → two rerolls in hand
    s.exert(ch.id, id, 'stamina', 'Mara')
    expect(s.currentChallenge()!.resolution!.rerolled).toBeUndefined() // nothing rerolled yet

    reroll(s, ch.id, id, 'resolution', 0, 'Mara')
    expect(s.currentChallenge()!.resolution!.rerolled).toEqual([1, 0])
    reroll(s, ch.id, id, 'resolution', 0, 'Mara') // the same die again
    expect(s.currentChallenge()!.resolution!.rerolled).toEqual([2, 0])
    expect(s.currentChallenge()!.framing!.rerolled).toBeUndefined() // the other roll is untouched
    expect(s.availableExertion(s.currentChallenge()!)).toBe(0) // both exertions spent
  })

  test('a point is spent as +1 or a reroll — the reroll has to be chosen first', async () => {
    const { s, id, ch } = await rolledChallenge()
    s.exert(ch.id, id, 'stamina', 'Mara')
    expect(s.rerollDie(ch.id, id, 'resolution', 0, 'Mara')).toBe(false) // not chosen yet

    expect(s.setExertionReroll(ch.id, id, true, 'Mara')).toBe(true)
    expect(s.currentChallenge()!.exertionRerollArmed).toBe(true)
    expect(s.spendExertion(ch.id, id, 'resolution', 'Mara')).toBe(false) // this point is a reroll now

    // Changing their mind hands the point back for either use.
    expect(s.setExertionReroll(ch.id, id, false, 'Mara')).toBe(true)
    expect(s.rerollDie(ch.id, id, 'resolution', 0, 'Mara')).toBe(false)
    expect(s.availableExertion(s.currentChallenge()!)).toBe(1)

    expect(s.setExertionReroll(ch.id, id, true, 'Mara')).toBe(true)
    expect(s.rerollDie(ch.id, id, 'framing', 1, 'Mara')).toBe(true) // any die, either roll
    expect(s.currentChallenge()!.exertionRerollArmed).toBe(false) // one die per point
    expect(s.availableExertion(s.currentChallenge()!)).toBe(0)
  })

  test('a reroll cannot be chosen without a point, or while an approach effect wants the dice', async () => {
    const { s, id, ch } = await challengeWithFace(1) // Limitless face 1: discard a die
    expect(s.setExertionReroll(ch.id, id, true, 'Mara')).toBe(false) // no exertion in hand
    s.exert(ch.id, id, 'stamina', 'Mara')
    expect(s.setExertionReroll(ch.id, id, true, 'Mara')).toBe(true)
    s.activateApproach(ch.id, id, 'Mara')
    expect(s.currentChallenge()!.exertionRerollArmed).toBe(false) // the effect took the dice over
    expect(s.setExertionReroll(ch.id, id, true, 'Mara')).toBe(false)
    s.discardDie(ch.id, id, 0, 'Mara')
    expect(s.setExertionReroll(ch.id, id, true, 'Mara')).toBe(true) // free again
  })

  test('nothing can be spent before the dice, or after the GM is done', async () => {
    const { s, id, ch } = await readyChallenge()
    expect(s.exert(ch.id, id, 'stamina', 'Mara')).toBe(false) // not rolled yet

    s.rollChallenge(ch.id, 'Mara')
    expect(s.closeChallenge(ch.id, 'GM')).toBe(true)
    expect(s.currentChallenge()!.closed).toBe(true)
    expect(s.closeChallenge(ch.id, 'GM')).toBe(false)
    expect(s.exert(ch.id, id, 'stamina', 'Mara')).toBe(false)
    expect(reroll(s, ch.id, id, 'resolution', 0, 'Mara')).toBe(false)
  })
})

describe('approach die', () => {
  test('the approach die lands with the roll', async () => {
    const { s, ch } = await readyChallenge('bold')
    expect(s.approachState(ch)).toBeNull() // nothing to show until the dice are in
    s.rollChallenge(ch.id, 'Mara')
    const die = s.currentChallenge()!.approachDie!
    expect(die).toBeGreaterThanOrEqual(1)
    expect(die).toBeLessThanOrEqual(6)
  })

  test('an "always" approach is in effect as soon as it is rolled', async () => {
    const { s } = await rolledChallenge('bold')
    expect(s.approachState(s.currentChallenge()!)!.status).toBe('active')
  })

  test('a "failure" approach is in effect only when the resolution failed at the roll', async () => {
    const failing = await rolledChallenge('stubborn', 30)
    expect(failing.s.approachState(failing.s.currentChallenge()!)!.status).toBe('active')

    const passing = await rolledChallenge('stubborn', 2)
    expect(passing.s.approachState(passing.s.currentChallenge()!)!.status).toBe('skipped')
  })

  test('a failed framing is enough for a "failure" approach, even with the resolution succeeding', async () => {
    const { s, id } = await rolledChallenge('stubborn', 9)
    for (let i = 0; i < 600; i++) {
      const ch = s.currentChallenge()!
      const math = s.challengeMath(ch)
      if (math.framing!.success === false && math.resolution!.success) {
        expect(ch.failingAtRoll).toBe(true)
        expect(s.approachState(ch)!.status).toBe('active')
        return
      }
      startAndRoll(s, id, 'stubborn', 9)
    }
    throw new Error('never rolled a failed framing with a successful resolution')
  })

  test('exerting the failed framing into a success leaves a "failure" approach in effect', async () => {
    const { s, id } = await rolledChallenge('stubborn', 9)
    for (let i = 0; i < 600; i++) {
      const ch = s.currentChallenge()!
      const math = s.challengeMath(ch)
      // Only the framing failed, and by little enough for the stamina pool (2) to rescue it.
      if (math.framing!.success === false && math.framing!.difference >= -2 && math.resolution!.success) {
        while (s.challengeMath(s.currentChallenge()!).framing!.success === false) {
          expect(s.exert(ch.id, id, 'stamina', 'Mara')).toBe(true)
          expect(s.spendExertion(ch.id, id, 'framing', 'Mara')).toBe(true)
        }
        const after = s.currentChallenge()!
        expect(s.challengeMath(after).success).toBe(true) // both rolls now succeed…
        expect(s.approachState(after)!.status).toBe('active') // …and Unbreakable is still there
        expect(s.approachState(after)!.canActivate || !s.approachState(after)!.effect).toBe(true)
        return
      }
      startAndRoll(s, id, 'stubborn', 9)
    }
    throw new Error('never rolled a framing failure within reach of the stamina pool')
  })

  test('with framing skipped only the resolution counts', async () => {
    const passing = await rolledChallenge('stubborn', 2, null)
    expect(passing.ch.failingAtRoll).toBe(false)
    expect(passing.s.approachState(passing.ch)!.status).toBe('skipped')
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

  test('a challenge with no approach has no die', async () => {
    const { s, ch } = await rolledChallenge(null)
    expect(ch.approachDie).toBeNull()
    expect(s.approachState(ch)).toBeNull()
  })
})

/** Every resolution die on the board, with the face it currently shows. */
const boardDice = (s: Session) =>
  s.currentChallenge()!.resolution!.faces!.map((face, index) => ({ index, face }))

/**
 * A rolled, activated Tweak challenge whose resolution roll can take both of its steps: one die
 * off the worst face to lower, and a *different* one off the best face to raise. The resolution
 * is a pair, so an unlucky roll (two 6s, say) has nowhere to go on one of the steps.
 */
async function tweakableBoth() {
  const { s, id, open } = await rolledChallenge('precise', 9)
  for (let i = 0; i < 600; i++) {
    const ch = s.currentChallenge()!
    const dice = boardDice(s)
    const low = dice.find((a) => a.face > 1 && dice.some((b) => b.index !== a.index && b.face < 6))
    const high = low && dice.find((b) => b.index !== low.index && b.face < 6)
    if (low && high) {
      if (!s.setApproachDie(ch.id, 2, 'GM')) throw new Error('could not set the approach die')
      if (!s.activateApproach(ch.id, id, 'Mara')) throw new Error('could not activate Tweak')
      return { s, id, open, ch: s.currentChallenge()!, low, high }
    }
    startAndRoll(s, id, 'precise', 9)
  }
  throw new Error('never rolled a resolution Tweak could both lower and raise')
}

/**
 * A rolled, activated Tweak challenge holding a die on `face`, plus another die the lowering step
 * is allowed to move — so the raise step can be reached without spending the pick on the die under
 * test. Rolls fresh challenges on one session until both turn up.
 */
async function tweakWithDieOn(face: number) {
  const { s, id, open } = await rolledChallenge('precise', 9)
  for (let i = 0; i < 600; i++) {
    const ch = s.currentChallenge()!
    const target = boardDice(s).find((d) => d.face === face)
    const spare = boardDice(s).find((d) => d.face > 1 && d.index !== target?.index)
    if (target && spare) {
      if (!s.setApproachDie(ch.id, 2, 'GM')) throw new Error('could not set the approach die')
      if (!s.activateApproach(ch.id, id, 'Mara')) throw new Error('could not activate Tweak')
      return { s, id, open, ch: s.currentChallenge()!, target, spare }
    }
    startAndRoll(s, id, 'precise', 9)
  }
  throw new Error(`never rolled a die on face ${face} alongside one Tweak could lower`)
}


describe('opposition roll', () => {
  const ABILITIES = { framingAbility: 'agility', resolutionAbility: 'strength' }

  /** Two finished characters, ready to be put on either side of a contest. */
  const twoPlayers = async () => {
    const { open } = await setup(CHALLENGE_RULES)
    const s = open()
    const mara = s.createCharacter('Mara').id
    const jorik = s.createCharacter('Jorik').id
    s.finalizeCharacter(mara, 'Mara')
    s.finalizeCharacter(jorik, 'Jorik')
    return { s, open, mara, jorik }
  }

  const start = (s: Session, a: object, b: object, description = 'Arm wrestle') =>
    s.startOpposition({ description, a, b } as never, 'GM')

  /** Walks a contest all the way to a result: both ready, both rolled. */
  const resolve = (s: Session, id: string) => {
    s.setOppositionReady(id, 'a', true, 'GM')
    s.setOppositionReady(id, 'b', true, 'GM')
    s.rollOpposition(id, 'a', 'GM')
    s.rollOpposition(id, 'b', 'GM')
    return s.currentOpposition()!
  }

  test('player vs player: a framing and a resolution check each, no difficulty anywhere', async () => {
    const { s, mara, jorik } = await twoPlayers()
    expect(start(s, { charId: mara, ...ABILITIES }, { charId: jorik, ...ABILITIES })).not.toBeNull()
    const opp = s.currentOpposition()!
    expect([opp.a.name, opp.b.name]).toEqual(['Mara', 'Jorik'])
    expect(opp.a.framingAbility).toBe('agility')
    expect(opp.a.resolutionAbility).toBe('strength')

    const done = resolve(s, opp.id)
    for (const one of [done.a, done.b]) {
      expect(one.framing!.dice).toHaveLength(2)
      expect(one.resolution!.dice).toHaveLength(2)
    }
    const outcome = s.oppositionOutcome(done)!
    expect(outcome.framing.aSum).toBe(done.a.framing!.sum)
    expect(outcome.framing.bSum).toBe(done.b.framing!.sum)
    expect(outcome.framing.margin).toBe(outcome.framing.aSum - outcome.framing.bSum)
  })

  test('each side\'s framing margin against the other picks its rung, whose bonus goes on its resolution', async () => {
    const { s, mara, jorik } = await twoPlayers()
    start(s, { charId: mara, ...ABILITIES }, { charId: jorik, ...ABILITIES })
    const done = resolve(s, s.currentOpposition()!.id)
    const o = s.oppositionOutcome(done)!
    const ladder = s.rules.challenges.framing
    // The same ladder a challenge uses: a reads +margin, b reads −margin.
    expect(o.rungs.a).toEqual(framingRung(ladder, o.framing.margin))
    expect(o.rungs.b).toEqual(framingRung(ladder, -o.framing.margin))
    expect(o.resolution.aSum).toBe(done.a.resolution!.sum + (o.rungs.a?.resolutionBonus ?? 0))
    expect(o.resolution.bSum).toBe(done.b.resolution!.sum + (o.rungs.b?.resolutionBonus ?? 0))
  })

  test('a big framing lead can swing a resolution the leader would otherwise lose', async () => {
    const { s } = await twoPlayers()
    // Framing rank 5 against 1 makes a big margin likely; keep contesting until the bonus decides.
    for (let i = 0; i < 2000; i++) {
      start(s, { name: 'Wolf', framingRank: 5, resolutionRank: 3 }, { name: 'Guard', framingRank: 1, resolutionRank: 3 })
      const done = resolve(s, s.currentOpposition()!.id)
      const o = s.oppositionOutcome(done)!
      const bare = (s.oppositionSum(done.a, 'resolution') ?? 0) - (s.oppositionSum(done.b, 'resolution') ?? 0)
      if (bare >= 0 || o.resolution.winner !== 'a') continue
      expect(o.winner).toBe('a') // behind on the dice, ahead once the framing bonus is in
      expect(o.decidedBy).toBe('resolution')
      return
    }
    throw new Error('the framing bonus never swung a resolution')
  })

  test('player vs npc and npc vs npc both work', async () => {
    const { s, mara } = await twoPlayers()
    const npc = { name: 'Guard', framingRank: 2, resolutionRank: 4 }
    expect(start(s, { charId: mara, ...ABILITIES }, npc)).not.toBeNull()
    expect(s.currentOpposition()!.b.name).toBe('Guard')
    expect(s.currentOpposition()!.b.charId).toBeNull()

    expect(start(s, { name: 'Wolf', framingRank: 5, resolutionRank: 5 }, npc)).not.toBeNull()
    const both = s.currentOpposition()!
    expect([both.a.charId, both.b.charId]).toEqual([null, null])
    const done = resolve(s, both.id)
    // An NPC rolls at its flat rank: every face shifted by (rank − 3).
    for (const [i, face] of done.a.resolution!.faces!.entries()) {
      expect(done.a.resolution!.dice[i]).toBe(face + (5 - 3))
    }
  })

  test('an unnamed contest, a missing ability or an off-ladder NPC rank are all refused', async () => {
    const { s, mara } = await twoPlayers()
    const ok = { charId: mara, ...ABILITIES }
    const npc = { name: 'Guard', framingRank: 3, resolutionRank: 3 }
    expect(start(s, ok, npc, '   ')).toBeNull()
    expect(start(s, { charId: mara, framingAbility: 'nope', resolutionAbility: 'strength' }, npc)).toBeNull()
    expect(start(s, { charId: 'nobody', ...ABILITIES }, npc)).toBeNull()
    expect(start(s, ok, { name: 'Guard', framingRank: 3, resolutionRank: 0 })).toBeNull() // ladder is 1..5
    expect(start(s, ok, { name: 'Guard', framingRank: 9, resolutionRank: 3 })).toBeNull()
    expect(s.oppositions).toHaveLength(0)
  })

  test('a commitment is hidden from the other side until both are ready', async () => {
    const { s, mara, jorik } = await twoPlayers()
    start(s, { charId: mara, ...ABILITIES }, { charId: jorik, ...ABILITIES })
    const opp = s.currentOpposition()!
    expect(s.oppositionPhase(opp)).toBe('committing')

    const see = (side: 'a' | 'b', role: 'gm' | 'player' | 'table', who?: string) =>
      s.oppositionCommitVisible(s.currentOpposition()!, side, role, who)

    expect(see('a', 'player', mara)).toBe(true) // your own is always yours to see
    expect(see('a', 'player', jorik)).toBe(false) // the opponent's is not
    expect(see('a', 'table')).toBe(false) // nor the shared screen's, which both can read
    expect(see('a', 'gm')).toBe(true) // the GM referees, so sees everything

    s.setOppositionReady(opp.id, 'a', true, 'Mara')
    expect(see('a', 'player', jorik)).toBe(false) // one side ready is not enough
    s.setOppositionReady(opp.id, 'b', true, 'Jorik')
    expect(s.oppositionPhase(s.currentOpposition()!)).toBe('rolling')
    expect(see('a', 'player', jorik)).toBe(true) // both ready: the commitments come out
    expect(see('b', 'table')).toBe(true)
  })

  test('stamina and skill are committed before the dice, and count towards the check', async () => {
    const { s, mara, jorik } = await twoPlayers()
    s.train(mara, 'athletics', 6, 'Mara') // 6 points = rank 3 in the fixture
    start(s, { charId: mara, ...ABILITIES }, { charId: jorik, ...ABILITIES })
    const opp = s.currentOpposition()!

    expect(s.commitOppositionExertion(opp.id, mara, 'resolution', 'stamina', 'Mara')).toBe(true)
    expect(s.commitOppositionExertion(opp.id, mara, 'framing', 'willpower', 'Mara')).toBe(true)
    expect(s.setOppositionSkill(opp.id, mara, 'athletics', 'Mara')).toBe(true)
    expect(s.oppositionSkillState(s.currentOpposition()!.a)).toMatchObject({ label: 'Athletics' })

    const committed = s.currentOpposition()!.a
    expect(committed.exertionResolution).toBe(1)
    expect(committed.exertionFraming).toBe(1)
    expect(s.oppositionSkillBonus(committed)).toBe(3) // the skill's rank, on each check
    // Burning a pool point shows on the sheet, as a challenge's exertion does.
    expect(s.statOf(s.characters.get(mara)!, 'stamina')!.current).toBe(1)

    const done = resolve(s, opp.id)
    // Exertion where it was put, and the whole skill rank (3) on both checks.
    expect(s.oppositionSum(done.a, 'resolution')).toBe(done.a.resolution!.sum + 1 + 3)
    expect(s.oppositionSum(done.a, 'framing')).toBe(done.a.framing!.sum + 1 + 3)
    expect(s.oppositionOutcome(done)!.framing.aSum).toBe(done.a.framing!.sum + 4)
    expect(s.oppositionSum(done.b, 'framing')).toBe(done.b.framing!.sum) // Jorik declared nothing
  })

  test('clearing the skill takes its bonus off both checks', async () => {
    const { s, mara, jorik } = await twoPlayers()
    s.train(mara, 'athletics', 6, 'Mara') // rank 3
    start(s, { charId: mara, ...ABILITIES }, { charId: jorik, ...ABILITIES })
    const opp = s.currentOpposition()!
    s.setOppositionSkill(opp.id, mara, 'athletics', 'Mara')
    expect(s.oppositionSkillBonus(s.currentOpposition()!.a)).toBe(3)
    s.setOppositionSkill(opp.id, mara, null, 'Mara')
    expect(s.currentOpposition()!.a.skill).toBeNull()
    expect(s.oppositionSkillBonus(s.currentOpposition()!.a)).toBe(0)
  })

  test('a ready side cannot change its commitment, and only un-ready before the reveal', async () => {
    const { s, mara, jorik } = await twoPlayers()
    start(s, { charId: mara, ...ABILITIES }, { charId: jorik, ...ABILITIES })
    const opp = s.currentOpposition()!

    s.setOppositionReady(opp.id, 'a', true, 'Mara')
    expect(s.commitOppositionExertion(opp.id, mara, 'resolution', 'stamina', 'Mara')).toBe(false)
    expect(s.setOppositionSkill(opp.id, mara, 'athletics', 'Mara')).toBe(false)
    expect(s.setOppositionReady(opp.id, 'a', false, 'Mara')).toBe(true) // still time to change
    expect(s.commitOppositionExertion(opp.id, mara, 'resolution', 'stamina', 'Mara')).toBe(true)

    s.setOppositionReady(opp.id, 'a', true, 'Mara')
    s.setOppositionReady(opp.id, 'b', true, 'Jorik')
    expect(s.setOppositionReady(opp.id, 'a', false, 'Mara')).toBe(false) // the reveal is done
  })

  test('nobody rolls before both are ready, and nobody rolls twice', async () => {
    const { s, mara, jorik } = await twoPlayers()
    start(s, { charId: mara, ...ABILITIES }, { charId: jorik, ...ABILITIES })
    const opp = s.currentOpposition()!

    expect(s.rollOpposition(opp.id, 'a', 'Mara')).toBe(false) // nobody is ready
    s.setOppositionReady(opp.id, 'a', true, 'Mara')
    expect(s.rollOpposition(opp.id, 'a', 'Mara')).toBe(false) // only one side is
    s.setOppositionReady(opp.id, 'b', true, 'Jorik')
    expect(s.rollOpposition(opp.id, 'a', 'Mara')).toBe(true)
    expect(s.rollOpposition(opp.id, 'a', 'Mara')).toBe(false) // once each
    expect(s.oppositionOutcome(s.currentOpposition()!)).toBeNull() // still waiting on b
    expect(s.rollOpposition(opp.id, 'b', 'Jorik')).toBe(true)
    expect(s.oppositionOutcome(s.currentOpposition()!)).not.toBeNull()
  })

  test('nothing can be committed or readied once the dice are in', async () => {
    const { s, mara, jorik } = await twoPlayers()
    start(s, { charId: mara, ...ABILITIES }, { charId: jorik, ...ABILITIES })
    const opp = s.currentOpposition()!
    const done = resolve(s, opp.id)
    expect(s.oppositionPhase(done)).toBe('done')

    expect(s.commitOppositionExertion(opp.id, mara, 'resolution', 'stamina', 'Mara')).toBe(false)
    expect(s.setOppositionSkill(opp.id, mara, 'athletics', 'Mara')).toBe(false)
    expect(s.setOppositionReady(opp.id, 'a', false, 'Mara')).toBe(false)
    expect(s.rollOpposition(opp.id, 'a', 'Mara')).toBe(false)
  })

  test('someone who is not in the contest cannot commit to it', async () => {
    const { s, mara, jorik } = await twoPlayers()
    start(s, { charId: mara, ...ABILITIES }, { name: 'Guard', framingRank: 3, resolutionRank: 3 })
    const opp = s.currentOpposition()!
    expect(s.commitOppositionExertion(opp.id, jorik, 'resolution', 'stamina', 'Jorik')).toBe(false)
    expect(s.setOppositionSkill(opp.id, jorik, 'athletics', 'Jorik')).toBe(false)
  })

  test('the resolution decides when the two checks disagree', async () => {
    const { s, mara, jorik } = await twoPlayers()
    // Rolling is random, so keep contesting until a split turns up, then check which check won.
    for (let i = 0; i < 400; i++) {
      start(s, { charId: mara, ...ABILITIES }, { charId: jorik, ...ABILITIES })
      const done = resolve(s, s.currentOpposition()!.id)
      const o = s.oppositionOutcome(done)!
      if (!o.resolution.winner || !o.framing.winner || o.resolution.winner === o.framing.winner) continue
      expect(o.decidedBy).toBe('resolution')
      expect(o.winner).toBe(o.resolution.winner) // and not the side that took the framing
      expect(o.degrees).toBe(Math.floor(Math.abs(o.resolution.margin) / 3)) // high stakes: one per 3
      return
    }
    throw new Error('the two checks never disagreed')
  })

  test('a level resolution falls through to the framing', async () => {
    const { s, mara, jorik } = await twoPlayers()
    for (let i = 0; i < 2000; i++) {
      start(s, { charId: mara, ...ABILITIES }, { charId: jorik, ...ABILITIES })
      const done = resolve(s, s.currentOpposition()!.id)
      const o = s.oppositionOutcome(done)!
      if (o.resolution.winner || !o.framing.winner) continue
      expect(o.decidedBy).toBe('framing')
      expect(o.winner).toBe(o.framing.winner)
      expect(o.degrees).toBe(Math.floor(Math.abs(o.framing.margin) / 3))
      return
    }
    throw new Error('the resolution was never level with a decided framing')
  })

  test('level on both checks is a tie with no winner named', async () => {
    const { s, mara, jorik } = await twoPlayers()
    for (let i = 0; i < 2000; i++) {
      start(s, { charId: mara, ...ABILITIES }, { charId: jorik, ...ABILITIES })
      const done = resolve(s, s.currentOpposition()!.id)
      const o = s.oppositionOutcome(done)!
      if (o.resolution.winner || o.framing.winner) continue
      expect(o.winner).toBeNull()
      expect(o.decidedBy).toBeNull()
      expect(o.degrees).toBe(0)
      return
    }
    throw new Error('never rolled a dead heat on both checks')
  })

  test('survives a reopen, commitments and dice intact', async () => {
    const { s, open, mara, jorik } = await twoPlayers()
    s.train(mara, 'athletics', 6, 'Mara')
    start(s, { charId: mara, ...ABILITIES }, { charId: jorik, ...ABILITIES }, '  Shoving match  ')
    const opp = s.currentOpposition()!
    s.commitOppositionExertion(opp.id, mara, 'resolution', 'stamina', 'Mara')
    s.setOppositionSkill(opp.id, mara, 'athletics', 'Mara')
    const done = resolve(s, opp.id)

    const reopened = open()
    const replayed = reopened.currentOpposition()!
    expect(replayed).toEqual(done)
    expect(replayed.description).toBe('Shoving match')
    expect(replayed.a.exertionResolution).toBe(1)
    expect(replayed.a.skill).toBe('athletics')
    expect(reopened.oppositionOutcome(replayed)).toEqual(s.oppositionOutcome(done))
  })

  test('contests logged before the rename (core / support) still load: core = resolution, support = framing', async () => {
    const { s, open, mara } = await twoPlayers()
    s.train(mara, 'athletics', 6, 'Mara') // rank 3
    const side = (x: object) => ({ exertionCore: 0, exertionSupport: 0, skill: null, skillCore: 0, skillSupport: 0, ready: false, core: null, support: null, ...x })
    const log = (e: object) => (s as unknown as { append: (e: object) => void }).append({ by: 'GM', ...e })
    log({
      type: 'opposition_started',
      oppositionId: 'old1',
      description: 'Old contest',
      a: side({ charId: mara, name: 'Mara', coreAbility: 'strength', supportAbility: 'agility', coreRank: null, supportRank: null }),
      b: side({ charId: null, name: 'Guard', coreAbility: null, supportAbility: null, coreRank: 4, supportRank: 2 }),
    })
    log({ type: 'opposition_exerted', oppositionId: 'old1', side: 'a', check: 'core', charId: mara, stat: 'stamina', adj: -1, from: 2, to: 1 })
    log({ type: 'opposition_skill_set', oppositionId: 'old1', side: 'a', skill: 'athletics' })
    log({ type: 'opposition_skill_points_set', oppositionId: 'old1', side: 'a', core: 2, support: 1 }) // an old split: ignored
    const dice = (n: number) => ({ faces: [n, n], dice: [n, n], sum: n * 2 })
    log({ type: 'opposition_rolled', oppositionId: 'old1', side: 'a', core: dice(5), support: dice(2) })
    const opp = open().currentOpposition()!
    expect(opp.a).toMatchObject({ resolutionAbility: 'strength', framingAbility: 'agility', exertionResolution: 1 })
    expect(opp.a.skill).toBe('athletics')
    expect(opp.a.resolution!.sum).toBe(10)
    expect(opp.a.framing!.sum).toBe(4)
    expect(opp.b).toMatchObject({ resolutionRank: 4, framingRank: 2 })
  })
})

describe('solo roll', () => {
  /** A finished character exists in these, but a solo roll never involves one. */
  const soloSession = async () => {
    const { open } = await setup(CHALLENGE_RULES)
    return open()
  }

  test('solo rolls and challenges share one time order (for the history log), also after a restart', async () => {
    const { s, id, open } = await rolledChallenge()
    s.rollSolo({ difficulty: 7, rank: 3, visibility: 'public' }, 'GM')
    startAndRoll(s, id, 'bold', 9)
    const [first, second] = s.challenges.slice(-2)
    const solo = s.soloRolls.at(-1)!
    expect(first!.seq).toBeLessThan(solo.seq)
    expect(solo.seq).toBeLessThan(second!.seq)
    const replayed = open()
    expect(replayed.soloRolls.at(-1)!.seq).toBe(solo.seq)
    expect(replayed.challenges.at(-1)!.seq).toBe(second!.seq)
  })

  test('rolls two dice at the given rank, shifted like an ability side', async () => {
    const s = await soloSession()
    expect(s.rollSolo({ difficulty: 7, rank: 5, visibility: 'gm' }, 'GM')).not.toBeNull()
    const solo = s.currentSoloRoll()!
    expect(solo.rank).toBe(5)
    expect(solo.roll.dice).toHaveLength(2)
    expect(solo.roll.faces).toHaveLength(2)
    for (const [i, face] of solo.roll.faces!.entries()) {
      expect(face).toBeGreaterThanOrEqual(1)
      expect(face).toBeLessThanOrEqual(6)
      expect(solo.roll.dice[i]).toBe(face + (5 - 3)) // rank 5 shifts every face up 2
    }
    expect(solo.roll.sum).toBe(solo.roll.dice[0]! + solo.roll.dice[1]!)
  })

  test('the outcome is the roll against the opposition number, with no degrees', async () => {
    const s = await soloSession()
    s.rollSolo({ difficulty: 7, rank: 3, visibility: 'gm' }, 'GM')
    const solo = s.currentSoloRoll()!
    const outcome = s.soloOutcome(solo)
    expect(outcome.target).toBe(7)
    expect(outcome.sum).toBe(solo.roll.sum)
    expect(outcome.difference).toBe(solo.roll.sum - 7)
    expect(outcome.success).toBe(solo.roll.sum >= 7)
    expect(outcome.degrees).toBe(0) // solo rolls have no stakes, so never a boon or complication
  })

  test('the tier names the number only while it still matches that tier', async () => {
    const s = await soloSession()
    s.rollSolo({ difficulty: 4, tier: 'easy', rank: 3, visibility: 'gm' }, 'GM')
    expect(s.currentSoloRoll()!.tier).toBe('Easy') // 4 is Easy in the fixture

    s.rollSolo({ difficulty: 5, tier: 'easy', rank: 3, visibility: 'gm' }, 'GM')
    expect(s.currentSoloRoll()!.tier).toBeNull() // nudged off it, so it goes unnamed

    s.rollSolo({ difficulty: 4, tier: 'nonsense', rank: 3, visibility: 'gm' }, 'GM')
    expect(s.currentSoloRoll()!.tier).toBeNull()
  })

  test('the rank has to be on the ladder the rules describe', async () => {
    const s = await soloSession()
    // The fixture's abilities carry no scale, so the ladder is the 1..5 fallback.
    for (const rank of [0, 6, -1, 99, Number.NaN]) {
      expect(s.rollSolo({ difficulty: 7, rank, visibility: 'gm' }, 'GM')).toBeNull()
    }
    expect(s.rollSolo({ difficulty: 7, rank: Number.POSITIVE_INFINITY, visibility: 'gm' }, 'GM')).toBeNull()
    expect(s.rollSolo({ difficulty: Number.NaN, rank: 3, visibility: 'gm' }, 'GM')).toBeNull()
    expect(s.soloRolls).toHaveLength(0)
    expect(s.rollSolo({ difficulty: 7, rank: 1, visibility: 'gm' }, 'GM')).not.toBeNull()
    expect(s.rollSolo({ difficulty: 7, rank: 5, visibility: 'gm' }, 'GM')).not.toBeNull()
  })

  test('private unless asked otherwise, and revealable afterwards', async () => {
    const s = await soloSession()
    s.rollSolo({ difficulty: 7, rank: 3, visibility: 'gm' }, 'GM')
    const id = s.currentSoloRoll()!.id
    expect(s.currentSoloRoll()!.visibility).toBe('gm')

    expect(s.setSoloVisibility(id, 'public', 'GM')).toBe(true)
    expect(s.currentSoloRoll()!.visibility).toBe('public')
    expect(s.setSoloVisibility(id, 'public', 'GM')).toBe(false) // already there
    expect(s.setSoloVisibility(id, 'gm', 'GM')).toBe(true) // and it can be hidden again
    expect(s.currentSoloRoll()!.visibility).toBe('gm')
    expect(s.setSoloVisibility('nosuchid', 'public', 'GM')).toBe(false)
  })

  test('can be rolled public from the start', async () => {
    const s = await soloSession()
    s.rollSolo({ difficulty: 7, rank: 3, visibility: 'public' }, 'GM')
    expect(s.currentSoloRoll()!.visibility).toBe('public')
  })

  test('the latest is the current one, and a challenge is never disturbed', async () => {
    const { s, id, ch } = await rolledChallenge('bold', 9)
    const before = s.challengeMath(ch).resolution!.sum
    s.rollSolo({ difficulty: 7, rank: 3, visibility: 'gm', description: 'first' }, 'GM')
    s.rollSolo({ difficulty: 12, rank: 4, visibility: 'gm', description: 'second' }, 'GM')

    expect(s.soloRolls).toHaveLength(2)
    expect(s.currentSoloRoll()!.description).toBe('second')
    // The board is untouched: same challenge, same dice, same player.
    expect(s.currentChallenge()!.id).toBe(ch.id)
    expect(s.challengeMath(s.currentChallenge()!).resolution!.sum).toBe(before)
    expect(s.currentChallenge()!.charId).toBe(id)
  })

  test('survives a reopen, dice and visibility intact', async () => {
    const { open } = await setup(CHALLENGE_RULES)
    const s = open()
    s.rollSolo({ difficulty: 11, tier: 'easy', rank: 2, visibility: 'public', description: '  Guard patrol  ' }, 'GM')
    const solo = s.currentSoloRoll()!

    const replayed = open().currentSoloRoll()!
    expect(replayed).toEqual(solo)
    expect(replayed.description).toBe('Guard patrol') // trimmed on the way in
    expect(replayed.tier).toBeNull() // 11 is not the Easy value
    expect(replayed.visibility).toBe('public')
  })
})

describe('Setup (lower_face): lower one die a face', () => {
  test('Activate, then the tapped die drops one face, keeping its rank shift', async () => {
    const { s, id, ch } = await challengeOnFace(1, 'canny')
    const state = s.approachState(ch)!
    expect(state.effect!.kind).toBe('lower_face')
    // Make sure the resolution's first die can go lower.
    if (ch.resolution!.faces![0] === 1) s.setDieFace(ch.id, null, 'resolution', 0, 4, 'GM')
    const before = snapshot(s)
    expect(s.activateApproach(ch.id, id, 'Mara')).toBe(true)
    expect(s.currentChallenge()!.approachPicksLeft).toBe(1)
    expect(s.changeDieFace(ch.id, id, 0, 'Mara')).toBe(true)
    const after = s.currentChallenge()!.resolution!
    expect(after.faces![0]).toBe(before.faces[0]! - 1)
    expect(after.dice[0]).toBe(before.dice[0]! - 1)
    expect(after.changed![0]).toBe('lowered')
    expect(s.approachState(s.currentChallenge()!)!.pending).toBe(false)
    expect(s.changeDieFace(ch.id, id, 1, 'Mara')).toBe(false) // one die only
  })

  test('a framing die can be the one lowered', async () => {
    const { s, id, ch } = await challengeOnFace(1, 'canny')
    s.setDieFace(ch.id, null, 'framing', 1, 5, 'GM')
    s.activateApproach(ch.id, id, 'Mara')
    expect(s.changeDieFace(ch.id, id, 1, 'Mara', 'framing')).toBe(true)
    expect(s.currentChallenge()!.framing!.faces![1]).toBe(4)
  })

  test('a die already on the worst face is not offered', async () => {
    const { s, id, ch } = await challengeOnFace(1, 'canny')
    s.setDieFace(ch.id, null, 'resolution', 0, 1, 'GM')
    s.setDieFace(ch.id, null, 'resolution', 1, 4, 'GM')
    s.activateApproach(ch.id, id, 'Mara')
    const now = s.currentChallenge()!
    expect(s.tweakableDie(now, 0)).toBe(false)
    expect(s.changeDieFace(ch.id, id, 0, 'Mara')).toBe(false)
    expect(s.tweakableDie(now, 1)).toBe(true)
  })

  test('with every die on its worst face it cannot be activated', async () => {
    const { s, id, ch } = await challengeOnFace(1, 'canny')
    for (const roll of ['framing', 'resolution'] as const) {
      for (const i of [0, 1]) s.setDieFace(ch.id, null, roll, i, 1, 'GM')
    }
    const state = s.approachState(s.currentChallenge()!)!
    expect(state.canActivate).toBe(false)
    expect(s.activateApproach(ch.id, id, 'Mara')).toBe(false)
    // One die lifted off the bottom, and it is available again.
    s.setDieFace(ch.id, null, 'framing', 0, 2, 'GM')
    expect(s.approachState(s.currentChallenge()!)!.canActivate).toBe(true)
  })
})

describe('Perfect choice (max_face): one die to its top face', () => {
  test('Activate, then the tapped die goes to the top face, keeping its rank shift', async () => {
    const { s, id, ch } = await challengeOnFace(2, 'canny')
    expect(s.approachState(ch)!.effect!.kind).toBe('max_face')
    s.setDieFace(ch.id, null, 'resolution', 0, 2, 'GM')
    const before = snapshot(s)
    expect(s.activateApproach(ch.id, id, 'Mara')).toBe(true)
    expect(s.changeDieFace(ch.id, id, 0, 'Mara')).toBe(true)
    const after = s.currentChallenge()!.resolution!
    expect(after.faces![0]).toBe(6)
    expect(after.dice[0]).toBe(before.dice[0]! + 4)
    expect(after.changed![0]).toBe('maxed')
    expect(s.approachState(s.currentChallenge()!)!.pending).toBe(false)
    expect(s.changeDieFace(ch.id, id, 1, 'Mara')).toBe(false) // one die only
  })

  test('a framing die can be the one maxed; a die already at the top is not offered', async () => {
    const { s, id, ch } = await challengeOnFace(2, 'canny')
    s.setDieFace(ch.id, null, 'framing', 0, 6, 'GM')
    s.setDieFace(ch.id, null, 'framing', 1, 3, 'GM')
    s.activateApproach(ch.id, id, 'Mara')
    const now = s.currentChallenge()!
    expect(s.tweakableDie(now, 0, 'framing')).toBe(false)
    expect(s.changeDieFace(ch.id, id, 0, 'Mara', 'framing')).toBe(false)
    expect(s.changeDieFace(ch.id, id, 1, 'Mara', 'framing')).toBe(true)
    expect(s.currentChallenge()!.framing!.faces![1]).toBe(6)
  })

  test('with every die at its top face it cannot be activated', async () => {
    const { s, id, ch } = await challengeOnFace(2, 'canny')
    for (const roll of ['framing', 'resolution'] as const) {
      for (const i of [0, 1]) s.setDieFace(ch.id, null, roll, i, 6, 'GM')
    }
    expect(s.approachState(s.currentChallenge()!)!.canActivate).toBe(false)
    expect(s.activateApproach(ch.id, id, 'Mara')).toBe(false)
    s.setDieFace(ch.id, null, 'resolution', 1, 5, 'GM')
    expect(s.approachState(s.currentChallenge()!)!.canActivate).toBe(true)
  })
})

describe('hand edits: custom ±1 and Set die value', () => {
  test('the GM and the rolling player both nudge a roll, and it lands in that roll\'s sum', async () => {
    const { s, id, ch } = await rolledChallenge()
    const before = s.challengeMath(ch)
    expect(s.adjustCustom(ch.id, null, 'resolution', 1, 'GM')).toBe(true)
    expect(s.adjustCustom(ch.id, id, 'resolution', 1, 'Mara')).toBe(true)
    expect(s.adjustCustom(ch.id, id, 'framing', -1, 'Mara')).toBe(true)
    const after = s.currentChallenge()!
    expect(after.customResolution).toBe(2)
    expect(after.customFraming).toBe(-1)
    const math = s.challengeMath(after)
    expect(math.framing!.sum).toBe(before.framing!.sum - 1)
    // The resolution gets its +2, and follows whatever the framing's new rung is worth.
    expect(math.resolution!.sum).toBe(before.resolution!.sum + 2 - before.rungBonus + math.rungBonus)
    expect(s.adjustCustom(ch.id, id, 'resolution', 2, 'Mara')).toBe(false) // one step at a time
  })

  test('nobody else may, and not before the roll or after the GM is done', async () => {
    const { s, id, ch } = await readyChallenge()
    expect(s.adjustCustom(ch.id, null, 'resolution', 1, 'GM')).toBe(false) // not rolled yet
    s.rollChallenge(ch.id, 'Mara')
    const other = s.createCharacter('Bo').id
    s.finalizeCharacter(other, 'Bo')
    expect(s.adjustCustom(ch.id, other, 'resolution', 1, 'Bo')).toBe(false) // not their challenge
    expect(s.setDieFace(ch.id, other, 'resolution', 0, 1, 'Bo')).toBe(false)
    s.closeChallenge(ch.id, 'GM')
    expect(s.adjustCustom(ch.id, null, 'resolution', 1, 'GM')).toBe(false)
    expect(s.adjustCustom(ch.id, id, 'resolution', 1, 'Mara')).toBe(false)
    expect(s.setDieFace(ch.id, null, 'resolution', 0, 1, 'GM')).toBe(false)
  })

  test('a die is set onto the picked face, keeping its rank shift, and marked "Set"', async () => {
    const { s, id, ch } = await rolledChallenge()
    s.adjustBase(id, 'agility', 2, 'GM') // rank 5: faces shift +2 on dice rolled from now on
    const fresh = startAndRoll(s, id, 'bold', 9)
    const side = fresh.resolution!
    const face = side.faces![1] === 6 ? 1 : 6
    const shift = side.dice[1]! - side.faces![1]!
    expect(s.setDieFace(fresh.id, id, 'resolution', 1, face, 'Mara')).toBe(true)
    const after = s.currentChallenge()!.resolution!
    expect(after.faces![1]).toBe(face)
    expect(after.dice[1]).toBe(face + shift)
    expect(after.changed![1]).toBe('set')
    expect(after.sum).toBe(sideSum(after))
    expect(s.setDieFace(fresh.id, null, 'resolution', 1, face, 'GM')).toBe(false) // already on it
    expect(s.setDieFace(fresh.id, null, 'resolution', 0, 9, 'GM')).toBe(false) // no such face
  })

  test('added dice can be set, discarded ones cannot', async () => {
    const { s, id, ch } = await challengeWithFace(1) // Limitless face 1: discard a die
    s.activateApproach(ch.id, id, 'Mara')
    s.discardDie(ch.id, id, 0, 'Mara')
    expect(s.setDieFace(ch.id, null, 'resolution', 0, 3, 'GM')).toBe(false) // out of play
    s.setApproachDie(ch.id, 6, 'GM') // two extra dice
    s.activateApproach(ch.id, id, 'Mara')
    s.addApproachDice(ch.id, id, 'resolution', 'Mara')
    const faces = s.currentChallenge()!.resolution!.faces!
    const target = faces[3] === 6 ? 1 : 6
    expect(s.setDieFace(ch.id, id, 'resolution', 3, target, 'Mara')).toBe(true)
    expect(s.currentChallenge()!.resolution!.faces![3]).toBe(target)
  })

  test('hand edits survive a restart', async () => {
    const { s, id, ch, open } = await rolledChallenge()
    s.adjustCustom(ch.id, null, 'resolution', -1, 'GM')
    const face = ch.resolution!.faces![0] === 6 ? 1 : 6
    s.setDieFace(ch.id, id, 'resolution', 0, face, 'Mara')
    const replayed = open().currentChallenge()!
    expect(replayed.customResolution).toBe(-1)
    expect(replayed.resolution!.faces![0]).toBe(face)
    expect(replayed.resolution!.changed![0]).toBe('set')
  })
})

describe('circumstance modifier', () => {
  test('a plus raises the target and a minus lowers it', async () => {
    const { s, ch } = await rolledChallenge('bold', 9)
    expect(s.challengeMath(ch).target).toBe(9) // nothing applied yet

    expect(s.adjustCircumstance(ch.id, 1, 'GM')).toBe(true)
    expect(s.currentChallenge()!.circumstance).toBe(1)
    expect(s.challengeMath(s.currentChallenge()!).target).toBe(10) // a plus works against the player

    expect(s.adjustCircumstance(ch.id, -3, 'GM')).toBe(true)
    expect(s.currentChallenge()!.circumstance).toBe(-2)
    expect(s.challengeMath(s.currentChallenge()!).target).toBe(7) // a minus helps them
  })

  test('both rolls are judged against the adjusted target', async () => {
    const { s, ch } = await rolledChallenge('bold', 9)
    const before = s.challengeMath(ch)
    s.adjustCircumstance(ch.id, 2, 'GM')
    const after = s.challengeMath(s.currentChallenge()!)
    expect(after.framing!.target).toBe(11)
    expect(after.resolution!.target).toBe(11) // both rolls go against the same adjusted target
    expect(after.framing!.sum).toBe(before.framing!.sum) // the rolls themselves are untouched
    // The circumstance moved the target the framing's margin is measured against, so it can move
    // which rung that margin lands on — and with it, the bonus the rung adds to the resolution.
    expect(after.resolution!.sum).toBe(before.resolution!.sum - before.rungBonus + after.rungBonus)
    expect(after.framing!.difference).toBe(after.framing!.sum - 11)
  })

  test('steps stack but clamp, and a step that changes nothing is refused', async () => {
    const { s, ch } = await rolledChallenge('bold', 9)
    for (let i = 0; i < MAX_CIRCUMSTANCE; i++) {
      expect(s.adjustCircumstance(ch.id, 1, 'GM')).toBe(true)
    }
    expect(s.currentChallenge()!.circumstance).toBe(MAX_CIRCUMSTANCE)
    expect(s.adjustCircumstance(ch.id, 1, 'GM')).toBe(false) // already at the top
    expect(s.adjustCircumstance(ch.id, 0, 'GM')).toBe(false) // a no-op step
    expect(s.currentChallenge()!.circumstance).toBe(MAX_CIRCUMSTANCE)

    // A big step lands on the clamp rather than being thrown away.
    expect(s.adjustCircumstance(ch.id, -40, 'GM')).toBe(true)
    expect(s.currentChallenge()!.circumstance).toBe(-MAX_CIRCUMSTANCE)
    expect(s.adjustCircumstance(ch.id, Number.NaN, 'GM')).toBe(false)
  })

  test('it can be set before the rolls, and not after the GM closes the challenge', async () => {
    const { open } = await setup(CHALLENGE_RULES)
    const s = open()
    const id = s.createCharacter('Mara').id
    s.finalizeCharacter(id, 'Mara')
    const ch = startChallenge(s, 9)
    s.setChallengePlayer(ch.id, id, 'bold', null, 'GM')
    expect(s.adjustCircumstance(ch.id, 1, 'GM')).toBe(true) // before the dice are in
    s.rollChallenge(ch.id, 'Mara')
    expect(s.challengeMath(s.currentChallenge()!).framing!.target).toBe(10)
    expect(s.adjustCircumstance(ch.id, 2, 'GM')).toBe(true) // and after them
    s.closeChallenge(ch.id, 'GM')
    expect(s.adjustCircumstance(ch.id, 1, 'GM')).toBe(false) // but not once it is done
    expect(s.currentChallenge()!.circumstance).toBe(3)
  })

  test('it survives a reopen, landing on the same number however it was nudged', async () => {
    const { s, open, ch } = await rolledChallenge('bold', 9)
    s.adjustCircumstance(ch.id, 1, 'GM')
    s.adjustCircumstance(ch.id, 1, 'GM')
    s.adjustCircumstance(ch.id, -1, 'GM')

    const reopened = open()
    const replayed = reopened.currentChallenge()!
    expect(replayed.circumstance).toBe(1)
    expect(reopened.challengeMath(replayed).target).toBe(10)
  })

  test('lowering the target enough turns a failing resolution into a success, but a "failure" approach stays in effect', async () => {
    // A "failure" approach is decided once, at the moment the dice land (user decision) — a later
    // ruling that rescues the roll doesn't retroactively take Unbreakable away.
    const { s, id } = await rolledChallenge('stubborn', 9)
    for (let i = 0; i < 300; i++) {
      const ch = s.currentChallenge()!
      const math = s.challengeMath(ch)
      // Short by no more than the clamp, so one ruling can rescue the roll.
      if (math.success === false && math.resolution!.difference >= -MAX_CIRCUMSTANCE) {
        expect(ch.failingAtRoll).toBe(true)
        expect(s.approachState(ch)!.status).toBe('active') // failing, so Unbreakable applies
        s.adjustCircumstance(ch.id, math.resolution!.difference, 'GM')
        expect(s.challengeMath(s.currentChallenge()!).success).toBe(true)
        expect(s.approachState(s.currentChallenge()!)!.status).toBe('active') // still in effect
        return
      }
      startAndRoll(s, id, 'stubborn', 9)
    }
    throw new Error('never rolled a failure within reach of the circumstance clamp')
  })

  test('boosting a failing resolution with exertion also leaves a "failure" approach in effect', async () => {
    const { s, id } = await rolledChallenge('stubborn', 9)
    for (let i = 0; i < 300; i++) {
      const ch = s.currentChallenge()!
      const math = s.challengeMath(ch)
      // Short by no more than 2 (the fixture's stamina pool), so exertion alone can rescue it.
      if (math.success === false && math.resolution!.difference >= -2) {
        expect(ch.failingAtRoll).toBe(true)
        expect(s.approachState(ch)!.status).toBe('active')
        while (s.challengeMath(s.currentChallenge()!).success === false) {
          expect(s.exert(ch.id, id, 'stamina', 'Mara')).toBe(true)
          expect(s.spendExertion(ch.id, id, 'resolution', 'Mara')).toBe(true)
        }
        expect(s.approachState(s.currentChallenge()!)!.status).toBe('active') // still in effect
        expect(s.currentChallenge()!.failingAtRoll).toBe(true) // the snapshot never moves
        return
      }
      startAndRoll(s, id, 'stubborn', 9)
    }
    throw new Error('never rolled a failure within reach of the stamina pool')
  })
})

describe('Tweak (lower_raise): one die down a face, another up', () => {
  test('the first tap lowers, the second raises, and the effect is then done', async () => {
    const { s, id, ch, low, high } = await tweakableBoth()
    expect(s.approachState(ch)!.effect!.kind).toBe('lower_raise')
    expect(s.approachState(ch)!.step).toBe('first')

    const beforeLow = snapshot(s)
    expect(s.tweakableDie(ch, low.index)).toBe(true)
    expect(s.changeDieFace(ch.id, id, low.index, 'Mara')).toBe(true)
    const lowered = s.currentChallenge()!.resolution!
    // An offered die always has somewhere to go, so it moves exactly one face and is marked.
    expect(lowered.faces![low.index]).toBe(beforeLow.faces[low.index]! - 1)
    expect(lowered.dice[low.index]).toBe(beforeLow.dice[low.index]! - 1)
    expect(lowered.changed![low.index]).toBe('lowered')

    expect(s.approachState(s.currentChallenge()!)!.step).toBe('second')
    const beforeHigh = snapshot(s)
    expect(s.changeDieFace(ch.id, id, high.index, 'Mara')).toBe(true)
    const raised = s.currentChallenge()!.resolution!
    expect(raised.faces![high.index]).toBe(beforeHigh.faces[high.index]! + 1)
    expect(raised.changed![high.index]).toBe('raised')

    expect(s.currentChallenge()!.approachPicksLeft).toBe(0)
    expect(s.approachState(s.currentChallenge()!)!.pending).toBe(false)
  })

  test('a die already on the worst face is not a legal target for the lowering step', async () => {
    const { s, id, ch, target } = await tweakWithDieOn(1)
    expect(s.approachState(ch)!.step).toBe('first')
    expect(s.tweakableDie(ch, target.index)).toBe(false) // so the board won't offer it
    expect(s.changeDieFace(ch.id, id, target.index, 'Mara')).toBe(false)
    expect(s.currentChallenge()!.approachPicksLeft).toBe(2) // the pick is not spent
    expect(s.currentChallenge()!.resolution!.changed?.[target.index] ?? null).toBeNull()
  })

  test('a die already on the best face is not a legal target for the raising step', async () => {
    const { s, id, ch, target, spare } = await tweakWithDieOn(6)
    // Lowering first, on a different die, so the raise step is the one under test.
    expect(s.changeDieFace(ch.id, id, spare.index, 'Mara')).toBe(true)
    expect(s.approachState(s.currentChallenge()!)!.step).toBe('second')

    const now = s.currentChallenge()!
    expect(now.resolution!.faces![target.index]).toBe(6) // still on the best face
    expect(s.tweakableDie(now, target.index)).toBe(false)
    expect(s.changeDieFace(ch.id, id, target.index, 'Mara')).toBe(false)
    expect(now.approachPicksLeft).toBe(1) // still waiting for a legal raise
  })

  test('a die on the worst face can still be raised, and one on the best face lowered', async () => {
    // The restriction is per step, not a blanket ban: the end a die sits at is only a problem for
    // the direction that would push it further.
    const worst = await tweakWithDieOn(1)
    expect(worst.s.tweakableDie(worst.ch, worst.spare.index)).toBe(true)
    worst.s.changeDieFace(worst.ch.id, worst.id, worst.spare.index, 'Mara')
    const afterLower = worst.s.currentChallenge()!
    expect(afterLower.approachPicksLeft).toBe(1)
    expect(worst.s.tweakableDie(afterLower, worst.target.index)).toBe(true)
    expect(worst.s.changeDieFace(worst.ch.id, worst.id, worst.target.index, 'Mara')).toBe(true)
    expect(worst.s.currentChallenge()!.resolution!.faces![worst.target.index]).toBe(2)

    const best = await tweakWithDieOn(6)
    expect(best.s.tweakableDie(best.ch, best.target.index)).toBe(true) // lowering
    expect(best.s.changeDieFace(best.ch.id, best.id, best.target.index, 'Mara')).toBe(true)
    expect(best.s.currentChallenge()!.resolution!.faces![best.target.index]).toBe(5)
  })

  test('the raise cannot reuse the die that was just lowered', async () => {
    const { s, id, ch, low } = await tweakableBoth()
    expect(s.changeDieFace(ch.id, id, low.index, 'Mara')).toBe(true)
    expect(s.tweakableDie(s.currentChallenge()!, low.index)).toBe(false) // one pick per die
    expect(s.changeDieFace(ch.id, id, low.index, 'Mara')).toBe(false)
    expect(s.currentChallenge()!.approachPicksLeft).toBe(1)
  })

  test('every face moved stays inside the configured range', async () => {
    const { s, id, ch, low, high } = await tweakableBoth()
    s.changeDieFace(ch.id, id, low.index, 'Mara')
    s.changeDieFace(ch.id, id, high.index, 'Mara')
    for (const face of snapshot(s).faces) {
      expect(face).toBeGreaterThanOrEqual(1)
      expect(face).toBeLessThanOrEqual(6)
    }
  })
})

describe('Perfect balance (match_highest): the lowest die rises to the highest', () => {
  test('activating raises the lowest resolution die to the highest face', async () => {
    const { s, id, ch } = await challengeOnFace(3)
    expect(s.approachState(ch)!.effect!.kind).toBe('match_highest')

    const before = snapshot(s)
    const low = Math.min(...before.faces)
    const high = Math.max(...before.faces)
    const lowIndex = before.faces.indexOf(low)

    // It runs on every roll by itself, so there is no ability to pick: it applies the moment
    // Activate is pressed.
    expect(s.activateApproach(ch.id, id, 'Mara')).toBe(true)
    const after = s.currentChallenge()!.resolution!
    expect(after.faces![lowIndex]).toBe(high)
    expect(after.changed?.[lowIndex] ?? null).toBe(low === high ? null : 'matched')
    expect(after.sum).toBe(before.sum + (high - low))
    expect(s.currentChallenge()!.approachPicksLeft).toBe(0) // nothing left to tap
    expect(s.approachState(s.currentChallenge()!)!.pending).toBe(false)
  })

  test('face 4 does the same thing as face 3', async () => {
    const { s, ch } = await challengeOnFace(4)
    expect(s.approachState(ch)!.effect!.kind).toBe('match_highest')
  })

  test('the framing roll is balanced too, against its own dice', async () => {
    const { s, id, ch } = await challengeOnFace(3)
    const before = snapshot(s, 'framing')
    const low = Math.min(...before.faces)
    const high = Math.max(...before.faces)
    const lowIndex = before.faces.indexOf(low)
    s.activateApproach(ch.id, id, 'Mara')
    const after = s.currentChallenge()!.framing!
    expect(after.faces![lowIndex]).toBe(high)
    expect(after.changed?.[lowIndex] ?? null).toBe(low === high ? null : 'matched')
    expect(after.sum).toBe(before.sum + (high - low))
  })

  test('with framing skipped only the resolution roll is balanced', async () => {
    const { s, id, ch } = await rolledChallenge('precise', 9, null)
    s.setApproachDie(ch.id, 3, 'GM')
    expect(s.activateApproach(ch.id, id, 'Mara')).toBe(true)
    expect(s.currentChallenge()!.framing).toBeNull()
  })

  test('dice that already match move nothing', async () => {
    for (let i = 0; i < 300; i++) {
      const { s, id, ch } = await challengeOnFace(3)
      const { faces, sum } = snapshot(s)
      if (faces[0] !== faces[1]) continue
      s.activateApproach(ch.id, id, 'Mara')
      expect(s.currentChallenge()!.resolution!.sum).toBe(sum)
      expect(s.currentChallenge()!.resolution!.changed?.[0] ?? null).toBeNull()
      return
    }
    throw new Error('never rolled two equal resolution dice')
  })
})

describe('Perfect choice (discard_double): discard one die, copy another', () => {
  test('the discard comes first, then a copy of another die', async () => {
    const { s, id, ch } = await challengeOnFace(5)
    expect(s.approachState(ch)!.effect!.kind).toBe('discard_double')
    s.activateApproach(ch.id, id, 'Mara')

    const before = snapshot(s)
    expect(s.discardDie(ch.id, id, 0, 'Mara')).toBe(true)
    expect(s.currentChallenge()!.resolution!.discarded![0]).toBe(true)
    expect(s.currentChallenge()!.resolution!.sum).toBe(before.sum - before.dice[0]!)

    expect(s.approachState(s.currentChallenge()!)!.step).toBe('second')
    expect(s.duplicateDie(ch.id, id, 1, 'Mara')).toBe(true)
    const after = s.currentChallenge()!.resolution!
    expect(after.dice).toHaveLength(3)
    expect(after.faces![2]).toBe(before.faces[1]) // a twin of the tapped die
    expect(after.dice[2]).toBe(before.dice[1])
    expect(after.changed![2]).toBe('copied')
    expect(after.sum).toBe(before.dice[1]! * 2) // the survivor plus its twin
    expect(s.currentChallenge()!.approachPicksLeft).toBe(0)
  })

  test('face 6 does the same thing as face 5', async () => {
    const { s, ch } = await challengeOnFace(6)
    expect(s.approachState(ch)!.effect!.kind).toBe('discard_double')
  })

  test('the copy cannot be taken before the discard, and the discard only once', async () => {
    const { s, id, ch } = await challengeOnFace(5)
    s.activateApproach(ch.id, id, 'Mara')
    expect(s.duplicateDie(ch.id, id, 1, 'Mara')).toBe(false) // the discard comes first
    expect(s.discardDie(ch.id, id, 0, 'Mara')).toBe(true)
    expect(s.discardDie(ch.id, id, 1, 'Mara')).toBe(false) // the second pick is the copy
  })

  test('a discarded die cannot be the one copied', async () => {
    const { s, id, ch } = await challengeOnFace(5)
    s.activateApproach(ch.id, id, 'Mara')
    s.discardDie(ch.id, id, 0, 'Mara')
    // Out of play, and already spent as a pick; both reasons refuse it.
    expect(s.duplicateDie(ch.id, id, 0, 'Mara')).toBe(false)
    expect(s.duplicateDie(ch.id, id, 1, 'Mara')).toBe(true)
  })
})

describe('exertion rerolls reach every die on the resolution roll', () => {
  /** Burns `n` pool points so there is exertion in hand to spend. */
  const bank = (s: Session, chId: string, id: string, n: number) => {
    for (let i = 0; i < n; i++) {
      if (!s.exert(chId, id, i < 2 ? 'stamina' : 'willpower', 'Mara')) throw new Error('could not exert')
    }
  }

  test('a die added by extra_dice can be rerolled with exertion', async () => {
    // Limitless face 6 ("tricky" in the fixture) adds two dice to the roll the player picks.
    const { s, id, ch } = await challengeOnFace(6, 'tricky')
    expect(s.activateApproach(ch.id, id, 'Mara')).toBe(true)
    expect(s.addApproachDice(ch.id, id, 'resolution', 'Mara')).toBe(true)
    const grown = s.currentChallenge()!.resolution!
    expect(grown.dice).toHaveLength(4) // the original pair plus two

    bank(s, ch.id, id, 2)
    // The added dice are at index 2 and 3 — the bug refused anything but 0 and 1.
    for (const index of [2, 3]) {
      expect(reroll(s, ch.id, id, 'resolution', index, 'Mara')).toBe(true)
      const after = s.currentChallenge()!.resolution!
      expect(after.rerolled![index]).toBe(1)
      expect(after.sum).toBe(sideSum(after))
      expect(after.dice[index]).not.toBe(undefined)
    }
  })

  test('a copy added by discard_double can be rerolled too', async () => {
    const { s, id, ch } = await challengeOnFace(5)
    s.activateApproach(ch.id, id, 'Mara')
    s.discardDie(ch.id, id, 0, 'Mara')
    expect(s.duplicateDie(ch.id, id, 1, 'Mara')).toBe(true)
    expect(s.currentChallenge()!.resolution!.dice).toHaveLength(3)

    bank(s, ch.id, id, 1)
    expect(reroll(s, ch.id, id, 'resolution', 2, 'Mara')).toBe(true)
    const after = s.currentChallenge()!.resolution!
    expect(after.rerolled![2]).toBe(1)
    expect(after.changed![2]).toBe('copied') // still a copy, now rolled again
    expect(after.sum).toBe(sideSum(after))
  })

  test('a discarded die cannot be rerolled, and neither can an index off the roll', async () => {
    const { s, id, ch } = await challengeWithFace(1) // Limitless face 1 discards a die
    s.activateApproach(ch.id, id, 'Mara')
    expect(s.discardDie(ch.id, id, 0, 'Mara')).toBe(true)

    bank(s, ch.id, id, 2)
    expect(reroll(s, ch.id, id, 'resolution', 0, 'Mara')).toBe(false) // out of play
    expect(reroll(s, ch.id, id, 'resolution', 2, 'Mara')).toBe(false) // no such die
    expect(reroll(s, ch.id, id, 'resolution', -1, 'Mara')).toBe(false)
    expect(reroll(s, ch.id, id, 'resolution', 1.5, 'Mara')).toBe(false)
    expect(s.availableExertion(s.currentChallenge()!)).toBe(2) // nothing was spent on a refusal
    expect(reroll(s, ch.id, id, 'resolution', 1, 'Mara')).toBe(true) // the die still in play
  })
})

describe('approach die debug tool', () => {
  test('the GM forces the die onto any face, and that face is the one whose effect is offered', async () => {
    const { s, ch } = await rolledChallenge('tricky')
    expect(s.setApproachDie(ch.id, 4, 'GM')).toBe(true)
    const state = s.approachState(s.currentChallenge()!)!
    expect(state.die).toBe(4)
    expect(state.effect!.kind).toBe('extra_dice')
    expect(state.canActivate).toBe(true)
  })

  test('only faces of the die are accepted', async () => {
    const { s, ch } = await rolledChallenge('tricky')
    const was = s.currentChallenge()!.approachDie
    for (const bad of [0, 7, -1, 2.5, Number.NaN]) {
      expect(s.setApproachDie(ch.id, bad, 'GM')).toBe(false)
    }
    expect(s.currentChallenge()!.approachDie).toBe(was)
  })

  test('nothing to set before the resolution, without an approach, or once the challenge is done', async () => {
    const { open } = await setup(CHALLENGE_RULES)
    const s = open()
    const id = s.createCharacter('Mara').id
    s.finalizeCharacter(id, 'Mara')

    const ch = startChallenge(s, 9)
    s.setChallengePlayer(ch.id, id, 'tricky', null, 'GM')
    expect(s.setApproachDie(ch.id, 3, 'GM')).toBe(false) // nothing rolled yet
    s.rollChallenge(ch.id, 'Mara')
    expect(s.setApproachDie(ch.id, 3, 'GM')).toBe(true)
    s.closeChallenge(ch.id, 'GM')
    expect(s.setApproachDie(ch.id, 5, 'GM')).toBe(false) // done

    const noApproach = startAndRoll(s, id, null, 9)
    expect(s.setApproachDie(noApproach.id, 3, 'GM')).toBe(false)
  })

  test('a new face re-arms Activate and drops a pending pick, keeping what was already applied', async () => {
    const { s, id, ch } = await challengeWithFace(1, 'tricky') // face 1: discard a die
    expect(s.activateApproach(ch.id, id, 'Mara')).toBe(true)
    expect(s.currentChallenge()!.approachPicksLeft).toBe(1)
    expect(s.discardDie(ch.id, id, 0, 'Mara')).toBe(true)

    expect(s.setApproachDie(ch.id, 6, 'GM')).toBe(true) // face 6: two extra dice
    const after = s.currentChallenge()!
    expect(after.approachActivated).toBe(false)
    expect(after.approachPicksLeft).toBe(0)
    expect(after.approachPicked).toEqual([])
    expect(after.resolution!.discarded![0]).toBe(true) // the discard already happened
    expect(s.approachState(after)!.canActivate).toBe(true)
    expect(s.activateApproach(ch.id, id, 'Mara')).toBe(true)
    expect(s.currentChallenge()!.approachPicksLeft).toBe(1) // which roll gets the extra dice
    expect(s.addApproachDice(ch.id, id, 'resolution', 'Mara')).toBe(true)
    expect(s.currentChallenge()!.resolution!.dice).toHaveLength(4)
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

  test('face 1 discards a tapped die: it stops counting but stays on the roll', async () => {
    const { s, id, ch } = await challengeWithFace(1)
    const before = s.currentChallenge()!.resolution!
    expect(s.discardDie(ch.id, id, 0, 'Mara')).toBe(false) // not activated yet
    expect(s.activateApproach(ch.id, id, 'Mara')).toBe(true)
    expect(s.approachState(s.currentChallenge()!)!.pending).toBe(true)

    const dice = [...before.dice]
    expect(s.discardDie(ch.id, id, 0, 'Mara')).toBe(true)
    const after = s.currentChallenge()!.resolution!
    expect(after.dice).toEqual(dice) // the die is still shown
    expect(after.discarded).toEqual([true, false])
    expect(after.sum).toBe(after.dice[1]!)
    expect(s.approachState(s.currentChallenge()!)!.pending).toBe(false)

    // One pick only, and a discarded die can't be discarded again.
    expect(s.discardDie(ch.id, id, 1, 'Mara')).toBe(false)
  })

  test('face 3 rerolls a tapped die without spending exertion', async () => {
    const { s, id, ch } = await challengeWithFace(3)
    const kept = s.currentChallenge()!.resolution!.dice[1]
    s.activateApproach(ch.id, id, 'Mara')
    expect(s.approachReroll(ch.id, id, 0, 'Mara')).toBe(true)
    const after = s.currentChallenge()!
    expect(after.resolution!.dice[1]).toBe(kept)
    expect(after.resolution!.sum).toBe(sideSum(after.resolution!))
    expect(after.rerolls).toBe(0) // free: exertion is untouched
    expect(after.resolution!.rerolled).toEqual([1, 0]) // still counted on the die
    expect(s.availableExertion(after)).toBe(0)
    expect(s.approachReroll(ch.id, id, 0, 'Mara')).toBe(false) // one pick only
  })

  test('a tapped die may be on the framing roll', async () => {
    const { s, id, ch } = await challengeWithFace(1)
    const resolution = snapshot(s)
    s.activateApproach(ch.id, id, 'Mara')
    expect(s.discardDie(ch.id, id, 0, 'Mara', 'framing')).toBe(true)
    const after = s.currentChallenge()!
    expect(after.framing!.discarded).toEqual([true, false])
    expect(after.framing!.sum).toBe(after.framing!.dice[1]!)
    expect(snapshot(s)).toEqual(resolution) // the pick went to the framing roll alone
    expect(after.approachPicked).toEqual(['framing:0'])
    expect(s.discardDie(ch.id, id, 0, 'Mara')).toBe(false) // one pick only, on either roll
  })

  test('an approach reroll on the framing roll uses the framing rank', async () => {
    const { s, id, ch } = await challengeWithFace(3)
    s.activateApproach(ch.id, id, 'Mara')
    expect(s.approachReroll(ch.id, id, 1, 'Mara', 'framing')).toBe(true)
    const framing = s.currentChallenge()!.framing!
    expect(framing.rerolled).toEqual([0, 1])
    expect(framing.sum).toBe(sideSum(framing))
    expect(s.currentChallenge()!.rerolls).toBe(0) // still free
  })

  test('the pending effect only accepts its own kind of pick', async () => {
    const { s, id, ch } = await challengeWithFace(3)
    s.activateApproach(ch.id, id, 'Mara')
    expect(s.discardDie(ch.id, id, 0, 'Mara')).toBe(false)
    expect(s.changeDieFace(ch.id, id, 0, 'Mara')).toBe(false)
    expect(s.approachReroll(ch.id, id, 5, 'Mara')).toBe(false) // no such die
  })

  test('faces 4 and 5 add one die to the roll the player picks, face 6 adds two', async () => {
    for (const [face, extra] of [[4, 1], [5, 1], [6, 2]] as const) {
      for (const roll of ['framing', 'resolution'] as const) {
        const other = roll === 'framing' ? 'resolution' : 'framing'
        const { s, id, ch } = await challengeWithFace(face)
        const untouched = snapshot(s, other)
        expect(s.activateApproach(ch.id, id, 'Mara')).toBe(true)
        expect(s.approachState(s.currentChallenge()!)!.pending).toBe(true) // waiting for the pick
        expect(s.currentChallenge()![roll]!.dice).toHaveLength(2) // nothing added yet
        expect(s.addApproachDice(ch.id, id, roll, 'Mara')).toBe(true)
        const after = s.currentChallenge()!
        expect(after[roll]!.dice).toHaveLength(2 + extra)
        expect(after[roll]!.faces).toHaveLength(2 + extra)
        expect(after[roll]!.sum).toBe(sideSum(after[roll]!))
        expect(snapshot(s, other)).toEqual(untouched) // the other roll gets nothing
        expect(s.approachState(after)!.pending).toBe(false)
        expect(s.addApproachDice(ch.id, id, other, 'Mara')).toBe(false) // one roll only
        expect(s.activateApproach(ch.id, id, 'Mara')).toBe(false) // once only
      }
    }
  })

  test('with framing skipped the extra dice go straight onto the resolution', async () => {
    const { s, id, ch } = await rolledChallenge('tricky', 9, null)
    s.setApproachDie(ch.id, 6, 'GM')
    expect(s.activateApproach(ch.id, id, 'Mara')).toBe(true)
    const after = s.currentChallenge()!
    expect(after.resolution!.dice).toHaveLength(4)
    expect(after.approachPicksLeft).toBe(0) // nothing to choose
    expect(s.addApproachDice(ch.id, id, 'framing', 'Mara')).toBe(false)
  })

  test('extra dice take the rank shift of the roll they join', async () => {
    const { s, id, ch } = await challengeWithFace(6)
    s.adjustBase(id, 'agility', 2, 'GM') // rank 5 → every face +2
    s.activateApproach(ch.id, id, 'Mara')
    s.addApproachDice(ch.id, id, 'resolution', 'Mara')
    const side = s.currentChallenge()!.resolution!
    for (const i of [2, 3]) expect(side.dice[i]).toBe(side.faces![i]! + 2)
  })

  test('effects survive a restart and never apply once the GM is done', async () => {
    const { s, id, ch, open } = await challengeWithFace(1)
    s.activateApproach(ch.id, id, 'Mara')
    s.discardDie(ch.id, id, 1, 'Mara')
    const sum = s.currentChallenge()!.resolution!.sum
    s.closeChallenge(ch.id, 'GM')
    expect(s.discardDie(ch.id, id, 0, 'Mara')).toBe(false)
    expect(s.activateApproach(ch.id, id, 'Mara')).toBe(false)

    const replayed = open().currentChallenge()!
    expect(replayed.resolution!.discarded).toEqual([false, true])
    expect(replayed.resolution!.sum).toBe(sum)
    expect(replayed.approachActivated).toBe(true)
    expect(replayed.approachPicksLeft).toBe(0)
  })
})

describe('unbreakable-style approach effects', () => {
  /**
   * A challenge whose resolution is failing, rolled with the `stoic` approach on the given face.
   * Difficulty 10 rather than something unreachable: two d6 at rank 3 land 2..12, so the framing
   * margin cannot reach −9 and the critical-disadvantage rung never discards a resolution die —
   * leaving the pair of dice these effects are written against.
   */
  const failing = (face: number) =>
    challengeWithFace(face, 'stoic', 10, (s, ch) => s.challengeMath(ch).success === false)

  test('nothing applies until the player activates it', async () => {
    const { s, id, ch } = await failing(3)
    const before = s.currentChallenge()!.resolution!.faces!.slice()
    expect(s.approachState(ch)!.canActivate).toBe(true)
    expect(s.approachState(ch)!.pending).toBe(false)
    expect(s.changeDieFace(ch.id, id, 0, 'Mara')).toBe(false) // not activated yet
    expect(s.currentChallenge()!.resolution!.faces).toEqual(before)

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
    const before = s.currentChallenge()!.resolution!.faces!.slice()

    expect(s.changeDieFace(ch.id, id, 0, 'Mara')).toBe(true)
    expect(s.approachState(s.currentChallenge()!)!.picksLeft).toBe(1)
    expect(s.changeDieFace(ch.id, id, 0, 'Mara')).toBe(false) // never the same die twice
    expect(s.changeDieFace(ch.id, id, 1, 'Mara')).toBe(true)

    const done = s.currentChallenge()!.resolution!
    const raise = (was: number) => Math.min(6, was + 1)
    expect(done.faces![0]).toBe(raise(before[0]!))
    expect(done.faces![1]).toBe(raise(before[1]!))
    expect(done.sum).toBe(sideSum(done))
    // A die that was already on the top face cannot move, so it carries no marker.
    expect(done.changed![0]).toBe(before[0] === 6 ? null : 'raised')
    expect(s.approachState(s.currentChallenge()!)!.pending).toBe(false)
  })

  test('squashing sets two dice to the configured face, up or down', async () => {
    const { s, id, ch } = await failing(5)
    s.activateApproach(ch.id, id, 'Mara')
    const before = s.currentChallenge()!.resolution!.faces!.slice()
    s.changeDieFace(ch.id, id, 0, 'Mara')
    s.changeDieFace(ch.id, id, 1, 'Mara')

    const done = s.currentChallenge()!.resolution!
    expect(done.faces).toEqual([3, 3])
    expect(done.changed).toEqual([before[0] === 3 ? null : 'squashed', before[1] === 3 ? null : 'squashed'])
    expect(done.sum).toBe(sideSum(done))
  })

  test('an activated die stays active even after the resolution turns into a success', async () => {
    // Look for a failing roll that a point or two of exertion can turn into a success.
    const { s, id } = await rolledChallenge('stoic', 9)
    let ch = s.currentChallenge()!
    const shortBy = (c: typeof ch) => Math.max(0, -s.challengeMath(c).resolution!.difference)
    for (let i = 0; i < 300 && !(shortBy(ch) > 0 && shortBy(ch) <= 2 && s.approachState(ch)?.canActivate); i++) {
      ch = startAndRoll(s, id, 'stoic', 9)
    }
    expect(s.approachState(ch)!.status).toBe('active') // failing, so the button is offered
    s.activateApproach(ch.id, id, 'Mara')

    // Close the gap (stamina 2 + willpower 1 covers the 2 points this roll can be short).
    while (!s.challengeMath(s.currentChallenge()!).success) {
      if (!s.exert(ch.id, id, 'stamina', 'Mara')) s.exert(ch.id, id, 'willpower', 'Mara')
      s.spendExertion(ch.id, id, 'resolution', 'Mara')
    }
    // Succeeding now would normally skip a `when: failure` die; activation holds it in place.
    expect(s.approachState(s.currentChallenge()!)!.status).toBe('active')
  })

  test('a succeeding resolution offers nothing at all', async () => {
    const { s, id, ch } = await challengeWithFace(5, 'stoic', 2) // target 2: always a success
    const state = s.approachState(ch)!
    expect(state.status).toBe('skipped')
    expect(state.canActivate).toBe(false)
    expect(s.activateApproach(ch.id, id, 'Mara')).toBe(false)
  })

  test('picks and markers survive a restart', async () => {
    const { s, id, ch, open } = await failing(5)
    s.activateApproach(ch.id, id, 'Mara')
    s.changeDieFace(ch.id, id, 0, 'Mara')

    const replayed = open().currentChallenge()!
    expect(replayed.resolution!.faces![0]).toBe(3)
    expect(replayed.approachPicksLeft).toBe(1)
    expect(replayed.approachPicked).toEqual(['resolution:0'])
    expect(replayed.resolution!.sum).toBe(sideSum(replayed.resolution!))
  })
})
