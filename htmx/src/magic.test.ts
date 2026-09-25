import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadRules } from './rules'
import { Session } from './session'
import { Sheet } from './views/sheet'

const dirs: string[] = []
const opened: Session[] = []
afterEach(() => {
  for (const s of opened.splice(0)) s.close()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), 'roll-magic-'))
  dirs.push(dir)
  return dir
}
/** The real rules, one finished character with skill points to spend. */
const setup = async () => {
  const s = new Session(await loadRules(), join(tempDir(), 'session.db'))
  opened.push(s)
  const id = s.createCharacter('Mara').id
  s.finalizeCharacter(id, 'Mara')
  s.grantPoints(id, 20, 'GM')
  return { s, id, char: () => s.characters.get(id)! }
}
const MAGIC = ['shapeshifting', 'fireweaving', 'witchcraft', 'benediction']

describe('Mystical / Supernatural and the hidden magical skills', () => {
  test('the traits (Special, either/or, no modifiers) and the gated section load', async () => {
    const rules = await loadRules()
    const special = rules.traits.filter((t) => t.category === 'special')
    expect(special.map((t) => [t.id, t.cost, t.modifiers.length])).toEqual([
      ['mystical', -1, 0],
      ['supernatural', -2, 0],
    ])
    const section = rules.sections.find((x) => x.label === 'Magical Skills')!
    expect(section.requiresTraits).toEqual(['mystical', 'supernatural'])
    expect(section.fields.map((f) => f.id)).toEqual(MAGIC)
  })

  test('without the trait the skills are hidden and untrainable; with either trait they are there', async () => {
    const { s, id, char } = await setup()
    expect(MAGIC.every((f) => !s.fieldVisible(char(), f))).toBe(true)
    expect(s.fieldVisible(char(), 'athletics')).toBe(true)
    expect(s.train(id, 'fireweaving', 4, 'Mara')).toBe(false)
    expect(String(Sheet({ session: s, char: char() }))).not.toContain('Fireweaving')

    expect(s.addTrait(id, 'mystical', 'Mara')).toBe(true)
    expect(s.addTrait(id, 'supernatural', 'Mara')).toBe(false) // either/or
    expect(MAGIC.every((f) => s.fieldVisible(char(), f))).toBe(true)
    expect(s.train(id, 'fireweaving', 4, 'Mara')).toBe(true)
    expect(String(Sheet({ session: s, char: char() }))).toContain('Fireweaving')

    // Dropped again: hidden, can't be raised — but the points already on it can come back.
    s.removeTrait(id, 'mystical', 'Mara')
    expect(s.fieldVisible(char(), 'fireweaving')).toBe(false)
    expect(s.train(id, 'fireweaving', 1, 'Mara')).toBe(false)
    expect(s.train(id, 'fireweaving', -4, 'Mara')).toBe(true)
  })

  test('a hidden skill cannot be declared on a challenge', async () => {
    const { s, id } = await setup()
    s.startChallenge({ resolutionAbility: 'strength', difficulty: 7, stakes: 'normal' }, 'GM')
    const ch = s.currentChallenge()!
    expect(s.setChallengePlayer(ch.id, id, null, 'witchcraft', 'GM')).toBeNull()
    s.addTrait(id, 'supernatural', 'Mara')
    expect(s.setChallengePlayer(ch.id, id, null, 'witchcraft', 'GM')).not.toBeNull()
  })

  test('requires_traits must name real traits', async () => {
    const dir = tempDir()
    const path = join(dir, 'rules.yaml')
    const real = await Bun.file(join(import.meta.dir, '..', 'system', 'rules.yaml')).text()
    writeFileSync(path, real.replace('requires_traits: [mystical, supernatural]', 'requires_traits: [mystical, wizard]'))
    await expect(loadRules(path)).rejects.toThrow(/requires_traits names an unknown trait "wizard"/)
  })
})
