import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadRules } from './rules'
import { Session, type ChallengeSide } from './session'

const dirs: string[] = []
const opened: Session[] = []
afterEach(() => {
  for (const s of opened.splice(0)) s.close()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
const setup = async () => {
  const rules = await loadRules()
  const dir = mkdtempSync(join(tmpdir(), 'roll-magicroll-'))
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

describe('magic roll', () => {
  test('magnitude vs 0 gives floor(result / 3) successes; activating sets control to 3 each; magnitude locks', async () => {
    const { s, mara, reopen } = await setup()
    expect(s.startMagic({ charId: mara, magnitudeAbility: 'intuition', controlAbility: 'resolve', description: 'a wall of fire' }, 'GM')).not.toBeNull()
    const ch = s.currentChallenge()!
    expect(ch.charId).toBe(mara)
    expect(ch.magic).toEqual({ activated: null, npc: null })

    expect(s.rollChallenge(ch.id, 'Mara')).not.toBeNull()
    expect(ch.resolution).toBeNull()
    expect(s.magicStep(ch)).toBe('magnitude')
    const count = (dice: number[]) => {
      ch.framing = side(dice)
      return s.challengeMath(ch).magic!.successes
    }
    expect([count([1, 1]), count([1, 2]), count([2, 5]), count([3, 4]), count([6, 6])]).toEqual([0, 1, 2, 2, 4])
    // Exertion-like changes are live: +1 on 8 makes it 9 → 3 successes.
    ch.framing = side([4, 4])
    expect(s.adjustCustom(ch.id, mara, 'framing', 1, 'Mara')).toBe(true)
    expect(s.challengeMath(ch).magic).toMatchObject({ successes: 3, pointsToNextSuccess: 3 })

    expect(s.rollMagicControl(ch.id, mara, 4, 'Mara')).toBeNull() // more than it has
    expect(s.rollMagicControl(ch.id, mara, 0, 'Mara')).toBeNull()
    expect(s.closeChallenge(ch.id, 'GM')).toBe(false) // not before control
    expect(s.rollMagicControl(ch.id, mara, 2, 'Mara')).not.toBeNull()
    expect(s.magicStep(ch)).toBe('control')
    expect(s.challengeMath(ch).magic!.controlTarget).toBe(6)
    ch.resolution = side([3, 5])
    expect(s.challengeMath(ch).resolution).toMatchObject({ sum: 8, target: 6, difference: 2, success: true })
    // The magnitude is locked now.
    expect(s.adjustCustom(ch.id, mara, 'framing', 1, 'Mara')).toBe(false)
    expect(s.adjustCustom(ch.id, mara, 'resolution', -1, 'Mara')).toBe(true)
    expect(s.closeChallenge(ch.id, 'GM')).toBe(true)
    expect(reopen().challenges.at(-1)!.magic!.activated).toBe(2)
  })

  test('no success: nothing to activate, and the GM can finish it straight away', async () => {
    const { s, mara } = await setup()
    s.startMagic({ charId: mara, magnitudeAbility: 'intuition', controlAbility: 'resolve' }, 'GM')
    const ch = s.currentChallenge()!
    s.rollChallenge(ch.id, 'Mara')
    ch.framing = side([1, 1])
    expect(s.rollMagicControl(ch.id, mara, 1, 'Mara')).toBeNull()
    expect(s.closeChallenge(ch.id, 'GM')).toBe(true)
  })

  test('an NPC caster: the GM gives the ranks and rolls both checks; nobody else can', async () => {
    const { s, mara } = await setup()
    s.startMagic({ npc: { name: 'Hedge witch', magnitudeRank: 9, controlRank: 9 }, magnitudeAbility: 'intuition', controlAbility: 'resolve' }, 'GM')
    const ch = s.currentChallenge()!
    expect(ch.charId).toBeNull()
    expect(ch.magic!.npc).toEqual({ name: 'Hedge witch', magnitudeRank: 9, controlRank: 9 })
    expect(s.rollChallenge(ch.id, 'GM')).not.toBeNull()
    // Rank 9 shifts every die by +6: at least 14, so at least 4 successes.
    expect(ch.framing!.dice.every((d) => d >= 7)).toBe(true)
    expect(s.challengeMath(ch).magic!.successes).toBeGreaterThanOrEqual(4)
    expect(s.rollMagicControl(ch.id, mara, 1, 'Mara')).toBeNull() // not Mara's
    expect(s.rollMagicControl(ch.id, null, 1, 'GM')).not.toBeNull()
    expect(ch.resolution!.dice.every((d) => d >= 7)).toBe(true)
    expect(s.challengeMath(ch).success).toBe(true) // at least 14 vs 3
  })
})

describe('GM log notes', () => {
  test('a line of the GM text lands in the log in time order, trimmed; blank adds nothing; survives a reopen', async () => {
    const { s, reopen } = await setup()
    expect(s.addLogNote('   ', 'GM')).toBeNull()
    expect(s.addLogNote('  The bridge   collapses  ', 'GM')).not.toBeNull()
    s.addLogNote('Night falls', 'GM')
    expect(s.logNotes.map((n) => n.text)).toEqual(['The bridge collapses', 'Night falls'])
    expect(s.logNotes[0]!.seq).toBeLessThan(s.logNotes[1]!.seq)
    expect(reopen().logNotes.map((n) => n.text)).toEqual(['The bridge collapses', 'Night falls'])
  })
})
