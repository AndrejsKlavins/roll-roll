import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadRules, spinnerAdvantage, spinnerColor, spinnerExertionPool, type SpinnerConfig } from './rules'
import { Session } from './session'
import { spin, SpinnerChecks, spinnerMath, spinnerRanks } from './spinner'

const config: SpinnerConfig = {
  difficulties: [{ id: 'hard', label: 'Hard', value: -3 }],
  segments: [1, 3, 5, 7].map((value) => ({ value })),
  colors: [
    { value: 0, color: '#800000', ink: '#ffffff' },
    { value: 5, color: '#ffffff', ink: '#1b1a1f' },
    { value: 9, color: '#1c6432', ink: '#ffffff' },
  ],
  shiftPerRank: 2,
  advantageStep: 3,
  exertion: [
    { stat: 'stamina', abilities: ['strength', 'agility', 'endurance'] },
    { stat: 'willpower', abilities: null },
  ],
}
/** An rng that returns these 1-based segment numbers in turn. */
const seq = (...picks: number[]) => () => picks.shift()!

describe('spinner maths', () => {
  test('advantage: ±2 in the middle is nothing, every full 3 beyond is one step, uncapped', () => {
    const at = (m: number) => spinnerAdvantage(config, m)
    expect([-13, -9, -6, -5, -3, -2, 0, 2, 3, 5, 6, 12].map(at)).toEqual([-4, -3, -2, -1, -1, 0, 0, 0, 1, 1, 2, 4])
    expect(Object.is(at(-2), 0)).toBe(true) // not −0
  })

  test('ability rank shifts every value by (rank − 3) × 2', () => {
    expect(spin(config, 5, 1, 'best', seq(2)).spins).toEqual([{ segment: 1, value: 7 }])
    expect(spin(config, 1, 1, 'best', seq(2)).spins).toEqual([{ segment: 1, value: -1 }])
  })

  test('colours follow the outcome value; values past the ends take the end colour', () => {
    expect(spinnerColor(config, 5).color).toBe('#ffffff')
    expect(spinnerColor(config, 9).color).toBe('#1c6432')
    expect(spinnerColor(config, 20).color).toBe('#1c6432')
    expect(spinnerColor(config, -4).color).toBe('#800000')
  })

  test('keeps the best or the worst spin', () => {
    expect(spin(config, 3, 3, 'best', seq(2, 4, 1)).kept).toBe(1)
    expect(spin(config, 3, 3, 'worst', seq(2, 4, 1)).kept).toBe(2)
  })

  test('exertion pools follow the ability: listed ones first, the pool with no list for the rest', () => {
    expect(spinnerExertionPool(config, 'agility')).toBe('stamina')
    expect(spinnerExertionPool(config, 'intuition')).toBe('willpower')
  })

  test('rank pips: every full 3 is a rank, the next group fills on the way, the rest are empty', () => {
    expect(spinnerRanks(4, 3)).toEqual({ rank: 1, groups: [3, 1, 0], over: false })
    expect(spinnerRanks(-10, 3)).toEqual({ rank: 3, groups: [3, 3, 3], over: true })
    expect(spinnerRanks(-9, 3)).toEqual({ rank: 3, groups: [3, 3, 3], over: false })
    expect(spinnerRanks(0, 3)).toEqual({ rank: 0, groups: [0, 0, 0], over: false })
    expect(spinnerRanks(-2, 3)).toEqual({ rank: 0, groups: [2, 0, 0], over: false })
    expect(spinnerRanks(7, 2)).toEqual({ rank: 2, groups: [3, 3], over: true }) // framing: advantage stops at 2
  })

  test('the difficulty is added to the sum; the total is the outcome (0 or more succeeds)', () => {
    const checks = new SpinnerChecks()
    const started = { type: 'spinner_started', description: '', tier: null, framingAbility: null, resolutionAbility: 'strength', charId: 'c', by: 'GM' } as const
    checks.apply({ ...started, id: 1, checkId: 'a', modifier: -3 })
    // Logs from before modifiers carried a number to reach: 3 then meant what −3 means now.
    checks.apply({ ...started, id: 2, checkId: 'b', difficulty: 3 })
    for (const checkId of ['a', 'b']) {
      const check = checks.byId(checkId)!
      expect(check.difficulty).toBe(-3)
      checks.apply({ type: 'spinner_spun', id: 3, checkId, skill: null, skillBonus: 1, framing: null, advantage: 0, resolution: { rank: 3, spins: [{ segment: 0, value: 2 }], kept: 0 }, by: 'GM' })
      expect(spinnerMath(check).resolution).toMatchObject({ value: 2, skill: 1, difficulty: -3, total: 0 })
      expect(spinnerMath(check).success).toBe(true)
    }
  })
})

const dirs: string[] = []
const opened: Session[] = []
afterEach(() => {
  for (const s of opened.splice(0)) s.close()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const setup = async () => {
  const rules = await loadRules()
  const dir = mkdtempSync(join(tmpdir(), 'roll-spinner-'))
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
  return { rules, s, mara, reopen, tier: rules.spinner!.difficulties.find((d) => d.id === 'hard')! }
}

describe('spinner check in a session', () => {
  test('start and skill: finished characters, abilities, skills only before the framing spin', async () => {
    const { s, mara, tier } = await setup()
    const draft = s.createCharacter('Draft').id
    expect(s.startSpinnerCheck({ difficulty: 0, framingAbility: 'agility', resolutionAbility: 'strength', charId: draft }, 'GM')).toBeNull()
    expect(s.startSpinnerCheck({ difficulty: 0, framingAbility: 'nope', resolutionAbility: 'strength', charId: mara }, 'GM')).toBeNull()
    s.startSpinnerCheck({ difficulty: tier.value, framingAbility: 'agility', resolutionAbility: 'intuition', charId: mara }, 'GM')
    const check = s.spinners.current()!
    expect(check.tier).toBe(tier.label)
    expect(check.difficulty).toBe(tier.value)
    expect(s.setSpinnerSkill(check.id, 'agility', 'Mara')).toBe(false) // an ability, not a skill
    expect(s.setSpinnerSkill(check.id, 'athletics', 'Mara')).toBe(true)
    expect(s.spinSpinnerCheck(check.id, 'Mara')).not.toBeNull()
    expect(s.spinSpinnerCheck(check.id, 'Mara')).toBeNull() // once
    expect(s.setSpinnerSkill(check.id, null, 'Mara')).toBe(false)
  })

  test('two steps: the framing is open to exertion and circumstance until accepted; accepting spins the resolution', async () => {
    const { rules, s, mara, reopen, tier } = await setup()
    s.startSpinnerCheck({ difficulty: tier.value, framingAbility: 'agility', resolutionAbility: 'intuition', charId: mara }, 'GM')
    const check = s.spinners.current()!
    expect(s.exertSpinner(check.id, 'framing', 'bonus', 'Mara')).toBe(false) // nothing spun yet
    expect(s.acceptSpinnerFraming(check.id, 'Mara')).toBeNull()
    s.spinSpinnerCheck(check.id, 'Mara')
    expect(check.resolution).toBeNull()
    expect(s.exertSpinner(check.id, 'resolution', 'bonus', 'Mara')).toBe(false) // not open yet

    const char = s.characters.get(mara)!
    const stamina = s.statOf(char, 'stamina')!.current
    const willpower = s.statOf(char, 'willpower')!.current
    // Agility framing: paid in stamina. +1, then a re-spin that counts instead.
    expect(s.exertSpinner(check.id, 'framing', 'bonus', 'Mara')).toBe(true)
    expect(s.exertSpinner(check.id, 'framing', 'respin', 'GM')).toBe(true)
    expect(s.adjustSpinnerCircumstance(check.id, 'framing', 1, 'GM')).toBe(true)
    expect(s.statOf(char, 'stamina')!.current).toBe(stamina - 2)
    expect(s.statOf(char, 'willpower')!.current).toBe(willpower)
    expect(check.framing!.spins.length).toBe(2)
    expect(check.framing!.kept).toBe(1)
    expect(check.framing!.spins[1]!.respin).toBe(true)
    const framing = spinnerMath(check).framing!
    expect(framing.value).toBe(check.framing!.spins[1]!.value)
    expect(framing.total).toBe(framing.value + framing.skill + 1 + 1 + tier.value)

    expect(s.acceptSpinnerFraming(check.id, 'Mara')).not.toBeNull()
    expect(check.advantage).toBe(spinnerAdvantage(rules.spinner!, framing.total))
    expect(check.resolution!.spins.length).toBe(Math.abs(check.advantage!) + 1)
    // The framing is locked now.
    expect(s.exertSpinner(check.id, 'framing', 'bonus', 'Mara')).toBe(false)
    expect(s.adjustSpinnerCircumstance(check.id, 'framing', 1, 'GM')).toBe(false)
    // Intuition resolution: paid in willpower. A re-spin counts even if it is worse.
    const spinsBefore = check.resolution!.spins.length
    expect(s.exertSpinner(check.id, 'resolution', 'respin', 'Mara')).toBe(true)
    expect(s.exertSpinner(check.id, 'resolution', 'bonus', 'Mara')).toBe(true)
    expect(s.adjustSpinnerCircumstance(check.id, 'resolution', -1, 'GM')).toBe(true)
    expect(check.resolution!.kept).toBe(spinsBefore)
    expect(s.statOf(char, 'willpower')!.current).toBe(willpower - 2)
    const resolution = spinnerMath(check).resolution!
    expect(resolution.value).toBe(check.resolution!.spins[spinsBefore]!.value)
    expect(resolution.total).toBe(resolution.value + resolution.skill - 1 + 1 + tier.value)
    expect(spinnerMath(check).success).toBe(resolution.total >= 0)

    expect(s.closeSpinnerCheck(check.id, 'GM')).toBe(true)
    expect(s.exertSpinner(check.id, 'resolution', 'bonus', 'Mara')).toBe(false)

    // Replay lands on the same state (re-spins must not be applied twice).
    const again = reopen()
    expect(again.spinners.current()).toEqual(check)
    expect(again.statOf(again.characters.get(mara)!, 'willpower')!.current).toBe(willpower - 2)
  })

  test('the skill bonus is the value the sheet shows, a temporary ✎ change included', async () => {
    const { s, mara, tier } = await setup()
    s.grantPoints(mara, 10, 'GM')
    for (let i = 0; i < 4; i++) s.train(mara, 'melee_combat', 1, 'Mara') // rank 1
    s.adjustField(mara, 'melee_combat', 1, 'Mara') // ✎ +1 → the sheet shows 2
    s.startSpinnerCheck({ difficulty: tier.value, framingAbility: 'strength', resolutionAbility: 'strength', charId: mara }, 'GM')
    const check = s.spinners.current()!
    s.setSpinnerSkill(check.id, 'melee_combat', 'Mara')
    s.spinSpinnerCheck(check.id, 'Mara')
    expect(check.skillBonus).toBe(2)
  })

  test('framing skipped: Spin goes straight to one resolution spinner, no advantage', async () => {
    const { s, mara, tier, reopen } = await setup()
    expect(s.startSpinnerCheck({ difficulty: tier.value, framingAbility: null, resolutionAbility: 'strength', charId: mara }, 'GM')).not.toBeNull()
    const check = s.spinners.current()!
    expect(check.framingAbility).toBeNull()
    expect(s.adjustSpinnerCircumstance(check.id, 'framing', 1, 'GM')).toBe(false)
    expect(s.spinSpinnerCheck(check.id, 'Mara')).not.toBeNull()
    expect(check.framing).toBeNull()
    expect(check.advantage).toBe(0)
    expect(check.resolution!.spins.length).toBe(1)
    expect(s.acceptSpinnerFraming(check.id, 'Mara')).toBeNull() // nothing to accept
    expect(s.spinSpinnerCheck(check.id, 'Mara')).toBeNull() // once
    expect(s.exertSpinner(check.id, 'framing', 'bonus', 'Mara')).toBe(false)
    expect(s.exertSpinner(check.id, 'resolution', 'respin', 'Mara')).toBe(true)
    expect(spinnerMath(check).success).not.toBeNull()
    expect(reopen().spinners.current()).toEqual(check)
  })

  test('no exertion with an empty pool', async () => {
    const { s, mara, tier } = await setup()
    s.startSpinnerCheck({ difficulty: tier.value, framingAbility: 'strength', resolutionAbility: 'strength', charId: mara }, 'GM')
    const check = s.spinners.current()!
    s.spinSpinnerCheck(check.id, 'Mara')
    const left = s.statOf(s.characters.get(mara)!, 'stamina')!.current
    for (let i = 0; i < left; i++) expect(s.exertSpinner(check.id, 'framing', 'bonus', 'Mara')).toBe(true)
    expect(s.exertSpinner(check.id, 'framing', 'bonus', 'Mara')).toBe(false)
  })
})
