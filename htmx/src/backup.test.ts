import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { characterToCsv, csvToSnapshot, parseCsv } from './backup'
import { loadRules } from './rules'
import { Session, type Character } from './session'

// The real rules file: it has traits, equipment, money and bio text — everything a backup carries.
const dirs: string[] = []
const opened: Session[] = []
afterEach(() => {
  // Close first: Windows won't delete a database file that is still open.
  for (const s of opened.splice(0)) s.close()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
const fresh = async () => {
  const dir = mkdtempSync(join(tmpdir(), 'roll-backup-'))
  dirs.push(dir)
  const rules = await loadRules()
  const db = join(dir, 'session.db')
  const open = () => {
    const session = new Session(rules, db)
    opened.push(session)
    return session
  }
  return { dir, rules, open }
}

/** A finished character with a bit of everything on it. */
const busyCharacter = (s: Session) => {
  const id = s.createCharacter('Mara').id
  s.setField(id, 'full_name', 'Mara "Quick" Vell, of the North', 'Mara')
  s.addTrait(id, 'strong', 'Mara')
  s.finalizeCharacter(id, 'Mara')
  s.setField(id, 'notes', 'Owes Jorik 5 coins,\nand a favour.', 'Mara')
  s.setField(id, 'money', '1250', 'Mara')
  s.levelUp(id, 'Mara')
  s.train(id, 'athletics', 4, 'Mara')
  s.adjustField(id, 'agility', -1, 'Mara') // a play change
  s.adjustStat(id, 'health', -2, 'Mara') // spent health
  s.addItem(id, 'Iron sword', [{ target: 'strength', delta: 1 }, { target: 'attack_damage', delta: 3 }], 'Mara')
  const shield = s.addItem(id, 'Old shield', [{ target: 'physical_resistance', delta: 2 }], 'Mara')!
  s.setItemEnabled(id, shield, false, 'Mara')
  return s.characters.get(id)!
}

/** Everything the sheet shows for a character: every field and stat, level, traits, items. */
const sheetOf = (s: Session, c: Character) => ({
  name: c.name,
  level: c.level,
  available: s.availablePoints(c),
  fields: [...s.rules.fields.values()].map((f) => [f.id, s.valueOf(c, f)]),
  stats: s.rules.derived.map((d) => [d.id, s.statOf(c, d.id)]),
  traits: c.traits,
  items: c.items.map((it) => [it.name, it.enabled, it.modifiers]),
})

describe('character backup (CSV)', () => {
  test('export, then import into an empty game, gives the same sheet', async () => {
    const a = await fresh()
    const s = a.open()
    const mara = busyCharacter(s)
    const csv = characterToCsv(s, mara)

    const b = await fresh()
    const t = b.open()
    const parsed = csvToSnapshot(t, csv)
    if ('error' in parsed) throw new Error(parsed.error)
    expect(parsed.warnings).toEqual([])
    const restored = t.importCharacter(parsed.snapshot, 'GM')!
    expect(restored.id).not.toBe(mara.id) // always a new character
    expect(sheetOf(t, restored)).toEqual(sheetOf(s, mara))
    // …and it survives a restart of the restored game.
    expect(sheetOf(b.open(), b.open().characters.get(restored.id)!)).toEqual(sheetOf(s, mara))
  })

  test('the file reads like the sheet: labels, quoted text, and current values for reading', async () => {
    const { open } = await fresh()
    const s = open()
    const csv = characterToCsv(s, busyCharacter(s))
    const rows = parseCsv(csv).filter((r) => !r[0]!.startsWith('#'))
    expect(rows[0]).toEqual(['kind', 'id', 'label', 'value'])
    expect(rows).toContainEqual(['base', 'strength', 'Strength', '4']) // 3 + the Strong trait
    expect(rows).toContainEqual(['value', 'full_name', 'Name', 'Mara "Quick" Vell, of the North'])
    expect(rows).toContainEqual(['value', 'notes', 'Notes', 'Owes Jorik 5 coins,\nand a favour.'])
    expect(rows).toContainEqual(['item', '', 'Iron sword', 'Strength +1; Attack damage +3'])
    expect(rows).toContainEqual(['item_disabled', '', 'Old shield', 'Physical resistance +2'])
    expect(rows.some((r) => r[0] === 'current' && r[1] === 'health')).toBe(true)
  })

  test('a hand edit in a spreadsheet comes through; current rows are ignored', async () => {
    const { open } = await fresh()
    const s = open()
    const csv = characterToCsv(s, busyCharacter(s))
      .replace('base,perception,Perception,3', 'base,perception,Perception,5')
      .replace(/current,strength,Strength,\d+/, 'current,strength,Strength,99')
    const parsed = csvToSnapshot(s, csv)
    if ('error' in parsed) throw new Error(parsed.error)
    const c = s.importCharacter(parsed.snapshot, 'GM')!
    expect(Number(s.valueOf(c, s.rules.fields.get('perception')!))).toBe(5)
    expect(Number(s.valueOf(c, s.rules.fields.get('strength')!))).toBe(5) // 4 base + 1 sword, not 99
  })

  test('things these rules no longer know are left out with a warning, not a failure', async () => {
    const { open } = await fresh()
    const s = open()
    const csv = [
      'kind,id,label,value',
      'name,,Name,Old Timer',
      'base,luck,Luck,4',
      'trait,cursed,Cursed,',
      'item,,Charm,Luck +2; Strength +1',
      'mystery,,,',
    ].join('\n')
    const parsed = csvToSnapshot(s, csv)
    if ('error' in parsed) throw new Error(parsed.error)
    expect(parsed.warnings).toHaveLength(4)
    expect(parsed.snapshot.items[0]!.modifiers).toEqual([{ target: 'strength', delta: 1 }])
    expect(parsed.snapshot.base.strength).toBe(3) // unmentioned abilities start at their default
  })

  test('a file that is not a character backup, or has no name, is refused', async () => {
    const { open } = await fresh()
    const s = open()
    expect(csvToSnapshot(s, 'hello,world\n1,2')).toHaveProperty('error')
    expect(csvToSnapshot(s, 'kind,id,label,value\nlevel,,Level,3')).toHaveProperty('error')
  })

  test('a spreadsheet saved with semicolons still reads', async () => {
    const { open } = await fresh()
    const s = open()
    const parsed = csvToSnapshot(s, 'kind;id;label;value\nname;;Name;Semi\nbase;strength;Strength;5\n')
    if ('error' in parsed) throw new Error(parsed.error)
    expect(parsed.snapshot).toMatchObject({ name: 'Semi', base: { strength: 5 } })
  })
})

describe('session log backup', () => {
  test('export, then import into another game, restores everything', async () => {
    const a = await fresh()
    const s = a.open()
    const mara = busyCharacter(s)
    s.startSession('GM')
    s.rollSolo({ description: 'Guard', difficulty: 7, rank: 3, visibility: 'public' }, 'GM')
    const log = s.exportLog()

    const b = await fresh()
    const t = b.open()
    t.createCharacter('Someone else') // replaced by the import
    const result = t.importLog(log)
    expect(result.ok).toBe(true)
    expect([...t.characters.keys()]).toEqual([mara.id])
    expect(sheetOf(t, t.characters.get(mara.id)!)).toEqual(sheetOf(s, mara))
    expect(t.soloRolls).toEqual(s.soloRolls)
    expect(t.sessionNumber()).toBe(s.sessionNumber())
    // It is the database now: a restart reads the same, and new events carry on after it.
    const reopened = b.open()
    expect(sheetOf(reopened, reopened.characters.get(mara.id)!)).toEqual(sheetOf(s, mara))
    const next = reopened.createCharacter('Jorik')
    expect(reopened.events.at(-1)!.id).toBeGreaterThan(s.events.at(-1)!.id)
    expect(reopened.characters.get(next.id)!.name).toBe('Jorik')
  })

  test('the log it replaces is saved first, so an import can itself be undone', async () => {
    const a = await fresh()
    const s = a.open()
    s.createCharacter('Before')
    const before = s.exportLog()
    const other = await fresh()
    const o = other.open()
    o.createCharacter('After')
    const result = s.importLog(o.exportLog())
    if (!result.ok) throw new Error(result.error)
    expect(existsSync(result.backup)).toBe(true)
    expect(readFileSync(result.backup, 'utf8')).toBe(before)
    s.importLog(readFileSync(result.backup, 'utf8'))
    expect([...s.characters.values()].map((c) => c.name)).toEqual(['Before'])
  })

  test('a broken file changes nothing', async () => {
    const { open } = await fresh()
    const s = open()
    s.createCharacter('Keep me')
    const events = s.events.length
    for (const bad of ['', 'not json', '{"type":"x"}', '{"id":2,"ts":1,"type":"a"}\n{"id":1,"ts":1,"type":"b"}']) {
      const result = s.importLog(bad)
      expect(result.ok).toBe(false)
    }
    expect(s.events).toHaveLength(events)
    expect([...s.characters.values()].map((c) => c.name)).toEqual(['Keep me'])
  })
})
