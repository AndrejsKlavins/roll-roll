import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadRules, type NumberField } from './rules'
import { Session } from './session'

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
rolls: []
`

const dirs: string[] = []
const opened: Session[] = []
afterEach(() => {
  for (const s of opened.splice(0)) s.close()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

async function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'roll-table-'))
  dirs.push(dir)
  writeFileSync(join(dir, 'rules.yaml'), RULES)
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

    // Base stays within creation range; current may exceed it.
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

  test('draft changes cannot touch base; active base fields cannot go below 0', async () => {
    const { open } = await setup()
    const s = open()
    const c = s.createCharacter('Mara')
    expect(s.adjustBase(c.id, 'strength', 1, 'Mara')).toBe(false)
    s.finalizeCharacter(c.id, 'Mara')
    s.setField(c.id, 'strength', -5, 'Mara')
    expect(s.valueOf(c, s.rules.fields.get('strength') as NumberField)).toBe(0)
  })
})
