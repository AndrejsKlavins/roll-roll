// Character backups: a finished character to a CSV a person can read (and fix by hand in a
// spreadsheet), and such a CSV back to a character snapshot, checked against the current rules.
import type { NumberField } from './rules'
import { isBaseField, MAX_ITEM_DELTA, type Character, type CharacterSnapshot, type Item, type Session } from './session'

/**
 * One row per value, with four columns: `kind, id, label, value`. `id` is what the importer
 * reads; `label` is only there for people. The kinds:
 *
 * | kind | id | value |
 * |---|---|---|
 * | name / level / skill_points_granted | — | the character's name, level, points ever granted |
 * | base | ability | its base value |
 * | skill_points | skill | points assigned to it (its rank follows from these) |
 * | value | bio / money / notes field | the text or number |
 * | play | ability or skill | a play change on top of base |
 * | stat_play | calculated stat | a play change (a pool's spent points are negative) |
 * | stat_bonus | calculated stat | a permanent shift from a trait |
 * | trait | trait | — (picked) |
 * | item / item_disabled | — | the item's name is the label; value "Strength +1; Attack damage +3" |
 * | current | field or stat | **for reading only** — what the sheet shows; ignored on import |
 *
 * Lines starting with `#` are comments.
 */
export function characterToCsv(session: Session, c: Character): string {
  const { rules } = session
  const rows: string[][] = [['kind', 'id', 'label', 'value']]
  const add = (kind: string, id: string, label: string, value: string | number) => rows.push([kind, id, label, String(value)])
  add('name', '', 'Name', c.name)
  add('level', '', 'Level', c.level)
  add('skill_points_granted', '', 'Skill points granted', c.pointsGranted)
  const fields = [...rules.fields.values()]
  for (const f of fields) {
    if (isBaseField(f) && !f.trained) add('base', f.id, f.label, session.baseOf(c, f))
  }
  for (const f of fields) {
    if (isBaseField(f) && f.trained && c.skillPoints[f.id]) add('skill_points', f.id, f.label, c.skillPoints[f.id]!)
  }
  for (const f of fields) {
    if (!isBaseField(f)) add('value', f.id, f.label, c.values[f.id] ?? f.default)
  }
  for (const f of fields) if (isBaseField(f) && c.adj[f.id]) add('play', f.id, f.label, c.adj[f.id]!)
  for (const d of rules.derived) {
    if (c.statAdj[d.id]) add('stat_play', d.id, d.label, c.statAdj[d.id]!)
    if (c.statBonus[d.id]) add('stat_bonus', d.id, d.label, c.statBonus[d.id]!)
  }
  for (const id of c.traits) add('trait', id, rules.traits.find((t) => t.id === id)?.label ?? id, '')
  for (const it of c.items) {
    const mods = it.modifiers.map((m) => `${session.itemTargetLabel(m.target)} ${m.delta > 0 ? '+' : ''}${m.delta}`)
    add(it.enabled ? 'item' : 'item_disabled', '', it.name, mods.join('; '))
  }
  // What the sheet shows right now, so the file reads like the sheet; the importer skips these.
  for (const f of fields) if (isBaseField(f)) add('current', f.id, f.label, session.valueOf(c, f))
  for (const d of rules.derived) {
    const stat = session.statOf(c, d.id)
    if (stat) add('current', d.id, d.label, d.pool ? `${stat.current} / ${stat.normal}` : stat.current)
  }
  // The comment stays free of names and quotes: a quote there would open a quoted cell.
  return '# Character backup. Rows of kind current are for reading only.\n' + rows.map(csvRow).join('\n') + '\n'
}

/**
 * Reads a character CSV back into a snapshot for Session.importCharacter. Anything the current
 * rules don't know (a field or trait since removed, an item target that no longer exists) is left
 * out and listed in `warnings` rather than failing the whole import; a missing name, or a file
 * that isn't a character CSV at all, is an `error`.
 */
export function csvToSnapshot(
  session: Session,
  text: string,
): { snapshot: CharacterSnapshot; warnings: string[] } | { error: string } {
  const { rules } = session
  const rows = parseCsv(text).filter((r) => r.some((cell) => cell.trim()) && !r[0]!.trimStart().startsWith('#'))
  const header = rows.shift()?.map((h) => h.trim().toLowerCase())
  if (!header || header[0] !== 'kind' || header[1] !== 'id' || header[3] !== 'value') {
    return { error: 'This is not a character backup (the first row should be: kind, id, label, value).' }
  }
  const warnings: string[] = []
  const snap: CharacterSnapshot = {
    name: '',
    level: 1,
    pointsGranted: 0,
    base: {},
    adj: {},
    statAdj: {},
    statBonus: {},
    skillPoints: {},
    values: {},
    traits: [],
    items: [],
  }
  const whole = (raw: string, where: string) => {
    const n = Number(raw.trim())
    if (raw.trim() === '' || !Number.isInteger(n)) {
      warnings.push(`${where}: "${raw}" is not a whole number — left out`)
      return null
    }
    return n
  }
  const numberField = (id: string) => rules.fields.get(id) as NumberField | undefined
  const stat = (id: string) => rules.derived.find((d) => d.id === id)
  for (const [line, row] of rows.entries()) {
    const [kind = '', id = '', label = '', value = ''] = row.map((cell) => cell ?? '')
    const k = kind.trim().toLowerCase()
    const key = id.trim()
    const where = `Row ${line + 2} (${k}${key ? ` ${key}` : ''})`
    switch (k) {
      case 'name':
        snap.name = value.trim()
        break
      case 'level': {
        const n = whole(value, where)
        if (n !== null) snap.level = Math.max(1, n)
        break
      }
      case 'skill_points_granted': {
        const n = whole(value, where)
        if (n !== null) snap.pointsGranted = n
        break
      }
      case 'base': {
        const f = numberField(key)
        if (!f || !isBaseField(f) || f.trained) warnings.push(`${where}: no ability "${key}" in these rules — left out`)
        else {
          const n = whole(value, where)
          if (n !== null) snap.base[key] = Math.min(f.max, Math.max(f.min, n))
        }
        break
      }
      case 'skill_points': {
        const f = numberField(key)
        if (!f || !f.trained) warnings.push(`${where}: no skill "${key}" in these rules — left out`)
        else {
          const n = whole(value, where)
          if (n !== null) snap.skillPoints[key] = Math.max(0, n)
        }
        break
      }
      case 'value': {
        const f = rules.fields.get(key)
        if (!f || isBaseField(f)) warnings.push(`${where}: no field "${key}" in these rules — left out`)
        else if (f.type === 'text') snap.values[key] = value.slice(0, 5000)
        else {
          const n = whole(value, where)
          // The type guard above rules out *every* number field, so name the plain one (money) here.
          const plain = f as NumberField | typeof f
          if (n !== null) {
            snap.values[key] =
              plain.type === 'track' ? Math.min(plain.max, Math.max(0, n)) : Math.min(plain.max, Math.max(plain.min, n))
          }
        }
        break
      }
      case 'play': {
        const f = numberField(key)
        if (!f || !isBaseField(f)) warnings.push(`${where}: no ability or skill "${key}" — left out`)
        else {
          const n = whole(value, where)
          if (n !== null) snap.adj[key] = n
        }
        break
      }
      case 'stat_play':
      case 'stat_bonus': {
        if (!stat(key)) warnings.push(`${where}: no calculated stat "${key}" — left out`)
        else {
          const n = whole(value, where)
          if (n !== null) (k === 'stat_play' ? snap.statAdj : snap.statBonus)[key] = n
        }
        break
      }
      case 'trait':
        if (!rules.traits.some((t) => t.id === key)) warnings.push(`${where}: no trait "${key}" in these rules — left out`)
        else if (!snap.traits.includes(key)) snap.traits.push(key)
        break
      case 'item':
      case 'item_disabled': {
        const item = parseItem(session, label, value, k === 'item', where, warnings)
        if (item) snap.items.push(item)
        break
      }
      case 'current':
        break // for reading only
      default:
        warnings.push(`${where}: unknown kind "${kind}" — skipped`)
    }
  }
  if (!snap.name) return { error: 'The backup has no name row, so there is no character to restore.' }
  // Abilities the file doesn't mention start at their default, like a new character.
  for (const f of rules.fields.values()) {
    if (isBaseField(f) && !f.trained && snap.base[f.id] === undefined) snap.base[f.id] = f.default
  }
  return { snapshot: snap, warnings }
}

/**
 * One item row: its name (the label column) and "Strength +1; Attack damage +3" — each part a
 * target (label or id, any case) and a signed whole number. Parts that can't be read are dropped
 * with a warning; an item left with no modifiers at all is dropped too.
 */
function parseItem(session: Session, name: string, mods: string, enabled: boolean, where: string, warnings: string[]): Item | null {
  const targets = session.itemTargets()
  const find = (t: string) => {
    const want = t.trim().toLowerCase()
    return targets.find((x) => x.id.toLowerCase() === want || x.label.toLowerCase() === want)
  }
  const modifiers: Item['modifiers'] = []
  for (const part of mods.split(';').map((p) => p.trim()).filter(Boolean)) {
    const m = part.match(/^(.*?)\s*([+-]\s*\d+)$/)
    const target = m && find(m[1]!)
    const delta = m ? Number(m[2]!.replace(/\s+/g, '')) : NaN
    if (!target || !Number.isInteger(delta) || delta === 0 || Math.abs(delta) > MAX_ITEM_DELTA) {
      warnings.push(`${where}: "${part}" is not a modifier these rules know — left out`)
    } else modifiers.push({ target: target.id, delta })
  }
  const clean = name.trim().replace(/\s+/g, ' ').slice(0, 60)
  if (!clean || modifiers.length === 0) {
    warnings.push(`${where}: item "${name}" has no name or no modifiers left — skipped`)
    return null
  }
  return { id: crypto.randomUUID().slice(0, 8), name: clean, modifiers, enabled }
}

/** One CSV line: cells with a comma, quote or line break are quoted, quotes doubled. */
function csvRow(cells: string[]) {
  return cells.map((c) => (/[",\r\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(',')
}

/**
 * RFC 4180-style CSV: quoted cells may hold commas, doubled quotes and line breaks (notes do).
 * Also takes the semicolons a spreadsheet in some locales saves with, when a row has no commas.
 */
export function parseCsv(text: string): string[][] {
  const src = text.replace(/^﻿/, '') // a BOM from Excel
  const firstLine = src.split(/\r?\n/, 1)[0] ?? ''
  const sep = !firstLine.includes(',') && firstLine.includes(';') ? ';' : ','
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') {
        cell += '"'
        i++
      } else if (ch === '"') quoted = false
      else cell += ch
    } else if (ch === '"') quoted = true
    else if (ch === sep) {
      row.push(cell)
      cell = ''
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++
      row.push(cell)
      rows.push(row)
      row = []
      cell = ''
    } else cell += ch
  }
  if (cell || row.length) {
    row.push(cell)
    rows.push(row)
  }
  return rows
}
