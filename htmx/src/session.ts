// Event log (SQLite) and the in-memory state rebuilt from it.
// Every change is an appended event; undo appends an "undo" event and rebuilds.
import { Database } from 'bun:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { evaluate } from './engine/expr'
import { computeScope, defaultValues, type Values } from './engine/sheet'
import type { Rules } from './rules'

export type Visibility = 'public' | 'gm' | 'hidden'

export type EventData =
  | { type: 'character_created'; charId: string; name: string }
  | { type: 'field_set'; charId: string; field: string; from: number | string; to: number | string; by: string }
  | {
      type: 'roll'
      charId: string | null // null = GM
      by: string
      label: string
      expr: string
      total: number
      breakdown: string
      visibility: Visibility
    }
  | { type: 'undo'; target: number; by: string }

export type LoggedEvent = EventData & { id: number; ts: number }
export type RollEvent = Extract<LoggedEvent, { type: 'roll' }>
export type FieldSetEvent = Extract<LoggedEvent, { type: 'field_set' }>

export type Character = { id: string; name: string; values: Values }

export class Session {
  readonly events: LoggedEvent[] = []
  readonly characters = new Map<string, Character>()
  private readonly undone = new Set<number>()
  private readonly db: Database

  constructor(readonly rules: Rules, dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true })
    this.db = new Database(dbPath, { create: true })
    this.db.run('PRAGMA journal_mode = WAL')
    this.db.run(`CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      type TEXT NOT NULL,
      data TEXT NOT NULL
    )`)
    const rows = this.db.query('SELECT id, ts, data FROM events ORDER BY id').all() as {
      id: number
      ts: number
      data: string
    }[]
    for (const row of rows) this.events.push({ ...JSON.parse(row.data), id: row.id, ts: row.ts })
    this.rebuild()
  }

  private append(data: EventData): LoggedEvent {
    const ts = Date.now()
    const { lastInsertRowid } = this.db
      .query('INSERT INTO events (ts, type, data) VALUES (?, ?, ?)')
      .run(ts, data.type, JSON.stringify(data))
    const event = { ...data, id: Number(lastInsertRowid), ts } as LoggedEvent
    this.events.push(event)
    if (event.type === 'undo') this.rebuild()
    else this.apply(event)
    return event
  }

  private rebuild() {
    this.characters.clear()
    this.undone.clear()
    for (const e of this.events) if (e.type === 'undo') this.undone.add(e.target)
    for (const e of this.events) this.apply(e)
  }

  private apply(e: LoggedEvent) {
    if (this.undone.has(e.id)) return
    switch (e.type) {
      case 'character_created':
        this.characters.set(e.charId, { id: e.charId, name: e.name, values: defaultValues(this.rules) })
        break
      case 'field_set': {
        const c = this.characters.get(e.charId)
        // Ignore fields that were removed from rules.yaml since the event was logged.
        if (c && this.rules.fields.has(e.field)) c.values[e.field] = e.to
        break
      }
    }
  }

  isUndone(id: number) {
    return this.undone.has(id)
  }

  scope(charId: string) {
    const c = this.characters.get(charId)
    return c ? computeScope(this.rules, c.values) : {}
  }

  createCharacter(name: string): Character {
    const charId = crypto.randomUUID().slice(0, 8)
    this.append({ type: 'character_created', charId, name: name.trim().slice(0, 40) || 'Nameless' })
    return this.characters.get(charId)!
  }

  /** Returns the event, or null if nothing changed. */
  setField(charId: string, fieldId: string, raw: string | number, by: string): FieldSetEvent | null {
    const c = this.characters.get(charId)
    const f = this.rules.fields.get(fieldId)
    if (!c || !f) return null
    const from = c.values[fieldId] ?? f.default
    let to: number | string
    if (f.type === 'text') {
      to = String(raw).slice(0, 5000)
    } else {
      const n = Math.round(Number(raw))
      if (!Number.isFinite(n)) return null
      const min = f.type === 'number' ? f.min : 0
      to = Math.min(f.max, Math.max(min, n))
    }
    if (to === from) return null
    return this.append({ type: 'field_set', charId, field: fieldId, from, to, by }) as FieldSetEvent
  }

  adjustField(charId: string, fieldId: string, delta: number, by: string) {
    const current = Number(this.characters.get(charId)?.values[fieldId])
    return Number.isFinite(current) ? this.setField(charId, fieldId, current + delta, by) : null
  }

  /** Undoes the character's most recent change that is still in effect. */
  undoLast(charId: string, by: string): FieldSetEvent | null {
    for (let i = this.events.length - 1; i >= 0; i--) {
      const e = this.events[i]!
      if (e.type === 'field_set' && e.charId === charId && !this.undone.has(e.id)) {
        this.append({ type: 'undo', target: e.id, by })
        return e
      }
    }
    return null
  }

  roll(opts: {
    charId: string | null
    label: string
    expr: string
    visibility: Visibility
  }): RollEvent {
    const c = opts.charId ? this.characters.get(opts.charId) : undefined
    const scope = c ? this.scope(c.id) : {}
    const result = evaluate(opts.expr, scope) // throws ExprError on bad input
    return this.append({
      type: 'roll',
      charId: c?.id ?? null,
      by: c?.name ?? 'GM',
      label: opts.label.slice(0, 60),
      expr: opts.expr.slice(0, 200),
      total: result.total,
      breakdown: result.breakdown,
      visibility: opts.visibility,
    }) as RollEvent
  }

  recentRolls(limit = 40): RollEvent[] {
    return this.events.filter((e): e is RollEvent => e.type === 'roll').slice(-limit)
  }

  recentChanges(limit = 40): LoggedEvent[] {
    return this.events.filter((e) => e.type === 'field_set' || e.type === 'undo').slice(-limit)
  }
}
