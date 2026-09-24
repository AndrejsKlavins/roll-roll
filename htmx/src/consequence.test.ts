import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadRules } from './rules'
import { Session } from './session'

const dirs: string[] = []
const opened: Session[] = []
afterEach(() => {
  for (const s of opened.splice(0)) s.close()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), 'roll-cons-'))
  dirs.push(dir)
  return dir
}
/** A session on the real rules file, which carries the boon and complication tables. */
const realSession = async () => {
  const s = new Session(await loadRules(), join(tempDir(), 'session.db'))
  opened.push(s)
  return s
}

describe('boons and complications', () => {
  test('the tables load: five faces (a d5), three ranks, the entries as written', async () => {
    const { consequences } = await loadRules()
    expect(consequences!.ranks).toBe(3)
    expect(consequences!.boon.faces).toHaveLength(5)
    expect(consequences!.complication.faces).toHaveLength(5)
    expect(consequences!.boon.faces[2]![1]).toEqual({
      title: 'Lucky 2',
      text: 'Find something useful (if applicable) in the value of up to 10',
    })
    expect(consequences!.complication.faces[3]![0]!.title).toBe('Overworked')
  })

  test('a roll reads the face the die lands on, at the rank picked', async () => {
    const s = await realSession()
    const sides: number[] = []
    const rigged = (n: number) => (sides.push(n), 3)
    const boon = s.rollConsequence('boon', 2, rigged)!
    expect(sides).toEqual([5]) // a d5: one side per face
    expect(boon).toMatchObject({ kind: 'boon', rank: 2, face: 3, sides: 5, entry: { title: 'Lucky 2' } })
    const bad = s.rollConsequence('complication', 3, () => 5)!
    expect(bad.entry.title).toBe('Gain hindrance 3')
  })

  test('every face turns up with the real die, and nothing is logged', async () => {
    const s = await realSession()
    const seen = new Set<number>()
    for (let i = 0; i < 300; i++) seen.add(s.rollConsequence('complication', 1)!.face)
    expect([...seen].sort()).toEqual([1, 2, 3, 4, 5])
    expect(s.events).toHaveLength(0) // the GM's private lookup
  })

  test('a rank the tables do not have is refused', async () => {
    const s = await realSession()
    for (const rank of [0, 4, 1.5, NaN]) expect(s.rollConsequence('boon', rank)).toBeNull()
  })

  test('a table with a face missing a rank, or faces out of order, fails at startup', async () => {
    const write = (body: string) => {
      const file = join(tempDir(), 'rules.yaml')
      writeFileSync(file, `name: T\nsections: []\nconsequences:\n${body}`)
      return loadRules(file)
    }
    await expect(
      write(`  boons:
    - { face: 1, ranks: [{ title: A }, { title: B }] }
  complications:
    - { face: 1, ranks: [{ title: C }] }
`),
    ).rejects.toThrow(/expected 2/)
    await expect(
      write(`  boons:
    - { face: 2, ranks: [{ title: A }] }
  complications:
    - { face: 1, ranks: [{ title: C }] }
`),
    ).rejects.toThrow(/in order from 1/)
  })
})
