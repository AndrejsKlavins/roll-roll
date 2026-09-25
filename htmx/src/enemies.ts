// Enemies (user-designed): templates the GM keeps in a bestiary, and instances spawned from them
// into the current encounter. Each instance carries its own copy of the stats, so the GM can tweak
// one wolf without touching the template or the other wolves.
//
// Templates start from the rules file (`enemies:`) and the GM can edit, add or delete them on the
// Bestiary screen; those changes are events like everything else, layered over the rules file's
// list (an edited built-in keeps its id, so re-editing the file doesn't bring back a deleted one).

/**
 * An enemy's numbers. A roll is `dice` d6, each face shifted by (rank − 3) — exactly like a
 * character's ability dice (rollChallengeSide) — plus the flat bonus. `health`/`mind` here are the
 * maximums; an instance tracks its current values separately.
 */
export type EnemyStats = {
  health: number
  mind: number
  hitDice: number
  hitRank: number
  hitBonus: number
  damageDice: number
  damageRank: number
  damageBonus: number
  evasion: number
  physicalResistance: number
  mentalResistance: number
  speed: number
}

export type EnemyStatKey = keyof EnemyStats

/** Every stat with its label and sanity limits (rounded and clamped into these on the way in). */
export const ENEMY_STATS: { key: EnemyStatKey; label: string; short: string; min: number; max: number }[] = [
  { key: 'health', label: 'Health', short: 'Health', min: 0, max: 99 },
  { key: 'mind', label: 'Mind', short: 'Mind', min: 0, max: 99 },
  { key: 'hitDice', label: 'To hit dice', short: 'Hit dice', min: 1, max: 9 },
  { key: 'hitRank', label: 'To hit rank', short: 'Hit rank', min: -9, max: 15 },
  { key: 'hitBonus', label: 'To hit bonus', short: 'Hit bonus', min: -20, max: 20 },
  { key: 'damageDice', label: 'Damage dice', short: 'Dmg dice', min: 1, max: 9 },
  { key: 'damageRank', label: 'Damage rank', short: 'Dmg rank', min: -9, max: 15 },
  { key: 'damageBonus', label: 'Damage bonus', short: 'Dmg bonus', min: -20, max: 20 },
  { key: 'evasion', label: 'Evasion', short: 'Evasion', min: -20, max: 40 },
  { key: 'physicalResistance', label: 'Physical resistance', short: 'Phys res', min: -20, max: 40 },
  { key: 'mentalResistance', label: 'Mental resistance', short: 'Ment res', min: -20, max: 40 },
  { key: 'speed', label: 'Speed', short: 'Speed', min: -9, max: 20 },
]

const STAT_KEYS = new Set<string>(ENEMY_STATS.map((s) => s.key))
export const isEnemyStatKey = (key: string): key is EnemyStatKey => STAT_KEYS.has(key)

export type EnemyTemplate = { id: string; name: string; description: string; stats: EnemyStats }

/** One enemy in the encounter. `health`/`mind` are current (max in `stats`); below 0 is down. */
export type Enemy = {
  id: string
  templateId: string
  name: string
  description: string
  stats: EnemyStats
  health: number
  mind: number
}

/** What the GM may change on one enemy: its name, its notes, any stat, and its current pools. */
export type EnemyPatch = {
  name?: string
  description?: string
  stats?: Partial<EnemyStats>
  health?: number
  mind?: number
}

export type EnemyEventData =
  | { type: 'enemy_template_saved'; template: EnemyTemplate; by: string }
  | { type: 'enemy_template_deleted'; templateId: string; by: string }
  | {
      type: 'enemies_spawned'
      templateId: string
      /** The template as it was — each spawned enemy starts from this copy. */
      description: string
      stats: EnemyStats
      enemies: { enemyId: string; name: string }[]
      by: string
    }
  | { type: 'enemy_updated'; enemyId: string; patch: EnemyPatch; by: string }
  | { type: 'enemies_removed'; enemyIds: string[]; by: string }
  // "Next round": every combatant's Evasion is fresh again (see Bestiary.attacked).
  | { type: 'combat_round_started'; by: string }

const ENEMY_EVENT_TYPES = new Set<string>([
  'enemy_template_saved',
  'enemy_template_deleted',
  'enemies_spawned',
  'enemy_updated',
  'enemies_removed',
  'combat_round_started',
])
export const isEnemyEvent = (e: { type: string }): e is EnemyEventData => ENEMY_EVENT_TYPES.has(e.type)

/** Current pools may go this far below 0 (a pile of wounds), no further. */
export const POOL_FLOOR = -99
/** At most this many enemies spawned in one go. */
export const MAX_SPAWN = 20

export const MAX_NAME = 40
export const MAX_DESCRIPTION = 1000

/** "2d6(3)": dice count, d6, and the rank in brackets (the notation the GM writes). */
export const diceLabel = (dice: number, rank: number) => `${dice}d6(${rank})`
export const bonusLabel = (n: number) => (n >= 0 ? `+${n}` : `${n}`)

/** Parses "2d6(3)" (or "2d6", which is rank 3 — a plain d6). Null for anything else. */
export function parseDice(text: string): { dice: number; rank: number } | null {
  const m = /^\s*(\d+)\s*d6\s*(?:\(\s*(-?\d+)\s*\))?\s*$/i.exec(text)
  if (!m) return null
  return { dice: Number(m[1]), rank: m[2] === undefined ? 3 : Number(m[2]) }
}

const clampStat = (key: EnemyStatKey, value: number) => {
  const def = ENEMY_STATS.find((s) => s.key === key)!
  return Math.min(def.max, Math.max(def.min, Math.round(value)))
}

/**
 * Cleans a set of stats: numbers only, rounded, clamped to ENEMY_STATS. With `base`, a missing or
 * unreadable value keeps the base's; without it, the whole set must be there (else null).
 */
export function cleanStats(input: Record<string, unknown>, base?: EnemyStats): EnemyStats | null {
  const out = {} as EnemyStats
  for (const { key } of ENEMY_STATS) {
    const raw = input[key]
    const n = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN
    if (Number.isFinite(n)) out[key] = clampStat(key, n)
    else if (base) out[key] = base[key]
    else return null
  }
  return out
}

export const cleanEnemyName = (name: string) => name.trim().replace(/\s+/g, ' ').slice(0, MAX_NAME)
const cleanDescription = (text: string) => text.replace(/\r\n/g, '\n').trim().slice(0, MAX_DESCRIPTION)

const newId = () => crypto.randomUUID().slice(0, 8)

/**
 * Parses the rules file's `enemies:` list — one row per template:
 *   { id: wolf, name: Wolf, health: 3, mind: 2, hit: 2d6(3), hit_bonus: 3, damage: 2d6(3),
 *     damage_bonus: 1, evasion: 8, physical_resistance: 3, mental_resistance: 3, speed: 3,
 *     description: "..." }
 */
export function parseEnemyTemplates(raw: unknown, fail: (msg: string) => void): EnemyTemplate[] {
  if (raw === undefined || raw === null) return []
  if (!Array.isArray(raw)) {
    fail('enemies: must be a list')
    return []
  }
  const seen = new Set<string>()
  return raw.flatMap((row: any, i): EnemyTemplate[] => {
    const where = `enemies[${i}]`
    const id = row?.id
    if (typeof id !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(id)) {
      fail(`${where}: id must be letters/digits/underscore, got ${JSON.stringify(id)}`)
      return []
    }
    if (seen.has(id)) fail(`${where}: duplicate enemy id "${id}"`)
    seen.add(id)
    const name = cleanEnemyName(String(row?.name ?? ''))
    if (!name) fail(`${where}: needs a name`)
    const dice = (key: 'hit' | 'damage') => {
      const d = parseDice(String(row?.[key] ?? ''))
      if (!d) fail(`${where}: ${key} must look like 2d6(3) (dice count, d6, rank), got ${JSON.stringify(row?.[key])}`)
      return d ?? { dice: 1, rank: 3 }
    }
    const hit = dice('hit')
    const damage = dice('damage')
    const flat: Record<string, unknown> = {
      health: row?.health,
      mind: row?.mind,
      hitDice: hit.dice,
      hitRank: hit.rank,
      hitBonus: row?.hit_bonus ?? 0,
      damageDice: damage.dice,
      damageRank: damage.rank,
      damageBonus: row?.damage_bonus ?? 0,
      evasion: row?.evasion,
      physicalResistance: row?.physical_resistance,
      mentalResistance: row?.mental_resistance,
      speed: row?.speed,
    }
    for (const [key, v] of Object.entries(flat)) {
      if (typeof v !== 'number' || !Number.isFinite(v)) fail(`${where}: ${key} must be a number, got ${JSON.stringify(v)}`)
    }
    const stats = cleanStats(flat)
    if (!stats) return []
    return [{ id, name, description: cleanDescription(String(row?.description ?? '')), stats }]
  })
}

/**
 * The bestiary's state, rebuilt from the event log by the session (which owns the log and calls
 * `apply`). The planning methods check a GM action and return the event to append (or null when
 * the action makes no sense); they never change state themselves.
 */
export class Bestiary {
  /** Templates the GM saved (new ones, and edits of built-ins under the built-in's id). */
  private readonly saved = new Map<string, EnemyTemplate>()
  private readonly deleted = new Set<string>()
  /** The current encounter, in spawn order. */
  readonly enemies: Enemy[] = []
  /** The combat round, from 1; "Next round" moves it on, emptying the encounter starts over. */
  round = 1
  /**
   * Who has been attacked this round — `enemy:<id>` or `char:<id>`. Their Evasion is spent: any
   * later attack on them this round rolls against 0 (user decision). Cleared by the next round.
   */
  private readonly attacked = new Set<string>()

  constructor(private readonly builtins: EnemyTemplate[]) {}

  reset() {
    this.saved.clear()
    this.deleted.clear()
    this.enemies.length = 0
    this.round = 1
    this.attacked.clear()
  }

  /** Something attacked this combatant this round (called by the session as attacks land). */
  markAttacked(kind: 'enemy' | 'char', id: string) {
    this.attacked.add(`${kind}:${id}`)
  }

  /** Whether this combatant's Evasion is spent for the rest of the round. */
  evasionSpent(kind: 'enemy' | 'char', id: string) {
    return this.attacked.has(`${kind}:${id}`)
  }

  /** Wounds from an attack come off an enemy's Health or Mind (never below the floor). */
  wound(enemyId: string, pool: 'health' | 'mind', wounds: number) {
    const en = this.enemy(enemyId)
    if (en && wounds > 0) en[pool] = Math.max(POOL_FLOOR, en[pool] - wounds)
  }

  /** The rules file's templates (as edited), then the GM's own, in the order they were made. */
  templates(): EnemyTemplate[] {
    const builtinIds = new Set(this.builtins.map((t) => t.id))
    return [
      ...this.builtins.map((t) => this.saved.get(t.id) ?? t),
      ...[...this.saved.values()].filter((t) => !builtinIds.has(t.id)),
    ].filter((t) => !this.deleted.has(t.id))
  }

  template(id: string) {
    return this.templates().find((t) => t.id === id)
  }

  isBuiltin(id: string) {
    return this.builtins.some((t) => t.id === id)
  }

  /** The built-in as the rules file has it — for "Reset to the rules file" on an edited one. */
  builtin(id: string) {
    return this.builtins.find((t) => t.id === id)
  }

  /** True when a built-in template differs from the rules file (a reset one no longer does). */
  isEdited(id: string) {
    const original = this.builtin(id)
    const saved = this.saved.get(id)
    return !!original && !!saved && JSON.stringify(saved) !== JSON.stringify(original)
  }

  enemy(id: string) {
    return this.enemies.find((e) => e.id === id)
  }

  /** The encounter in acting order: fastest first; equal Speed keeps spawn order. */
  bySpeed(): Enemy[] {
    return this.enemies
      .map((e, i) => ({ e, i }))
      .sort((a, b) => b.e.stats.speed - a.e.stats.speed || a.i - b.i)
      .map(({ e }) => e)
  }

  apply(e: EnemyEventData) {
    switch (e.type) {
      case 'enemy_template_saved':
        this.saved.set(e.template.id, e.template)
        this.deleted.delete(e.template.id)
        break
      case 'enemy_template_deleted':
        this.deleted.add(e.templateId)
        this.saved.delete(e.templateId)
        break
      case 'enemies_spawned':
        for (const one of e.enemies) {
          this.enemies.push({
            id: one.enemyId,
            templateId: e.templateId,
            name: one.name,
            description: e.description,
            stats: { ...e.stats },
            health: e.stats.health,
            mind: e.stats.mind,
          })
        }
        break
      case 'enemy_updated': {
        const en = this.enemy(e.enemyId)
        if (!en) break
        const { patch } = e
        if (patch.name !== undefined) en.name = patch.name
        if (patch.description !== undefined) en.description = patch.description
        if (patch.stats) {
          for (const [key, value] of Object.entries(patch.stats)) {
            if (!isEnemyStatKey(key) || typeof value !== 'number') continue
            // Lowering a maximum pulls the current value down with it; raising it leaves the
            // current value alone (a tougher wolf isn't healed by it).
            if (key === 'health') en.health = Math.min(en.health, value)
            if (key === 'mind') en.mind = Math.min(en.mind, value)
            en.stats[key] = value
          }
        }
        if (patch.health !== undefined) en.health = patch.health
        if (patch.mind !== undefined) en.mind = patch.mind
        break
      }
      case 'enemies_removed': {
        const gone = new Set(e.enemyIds)
        for (let i = this.enemies.length - 1; i >= 0; i--) if (gone.has(this.enemies[i]!.id)) this.enemies.splice(i, 1)
        // The fight is over once nobody is left: the next one starts at round 1, all fresh.
        if (this.enemies.length === 0) {
          this.round = 1
          this.attacked.clear()
        }
        break
      }
      case 'combat_round_started':
        this.round += 1
        this.attacked.clear()
        break
    }
  }

  // ---- planning GM actions (validated; each returns the event to log, or null) ----------------

  /** Save a template: a new one (no id), or an edit of an existing one (its id). */
  planSaveTemplate(
    input: { id?: string; name: string; description?: string; stats: Record<string, unknown> },
    by: string,
  ): EnemyEventData | null {
    const existing = input.id ? this.template(input.id) : undefined
    if (input.id && !existing) return null
    const name = cleanEnemyName(input.name)
    if (!name) return null
    const stats = cleanStats(input.stats, existing?.stats)
    if (!stats) return null
    return {
      type: 'enemy_template_saved',
      template: {
        id: existing?.id ?? `custom_${newId()}`,
        name,
        description: cleanDescription(input.description ?? existing?.description ?? ''),
        stats,
      },
      by,
    }
  }

  planDeleteTemplate(templateId: string, by: string): EnemyEventData | null {
    if (!this.template(templateId)) return null
    return { type: 'enemy_template_deleted', templateId, by }
  }

  /** An edited built-in back to what the rules file says. */
  planResetTemplate(templateId: string, by: string): EnemyEventData | null {
    const original = this.builtin(templateId)
    if (!original || !this.isEdited(templateId)) return null
    return { type: 'enemy_template_saved', template: structuredClone(original), by }
  }

  /**
   * Spawn `count` enemies from a template. They are numbered after any already in the encounter
   * from the same template ("Wolf 1", "Wolf 2", then "Wolf 3" for the next spawn).
   */
  planSpawn(templateId: string, count: number, by: string): EnemyEventData | null {
    const t = this.template(templateId)
    if (!t || !Number.isInteger(count) || count < 1 || count > MAX_SPAWN) return null
    const numberOf = (name: string) => {
      const m = name.startsWith(`${t.name} `) ? /^\d+$/.exec(name.slice(t.name.length + 1)) : null
      return m ? Number(m[0]) : 0
    }
    const highest = Math.max(0, ...this.enemies.filter((e) => e.templateId === t.id).map((e) => numberOf(e.name)))
    return {
      type: 'enemies_spawned',
      templateId: t.id,
      description: t.description,
      stats: { ...t.stats },
      enemies: Array.from({ length: count }, (_, i) => ({ enemyId: newId(), name: `${t.name} ${highest + i + 1}` })),
      by,
    }
  }

  /**
   * One change to one enemy, from a form field: `name`, `description`, a stat key (e.g.
   * `evasion`), or `health`/`mind` for the **current** pool (max is `stats.health`, edited as the
   * stat `maxHealth`/`maxMind`). Null when nothing would change.
   */
  planUpdate(enemyId: string, field: string, value: string, by: string): EnemyEventData | null {
    const en = this.enemy(enemyId)
    if (!en) return null
    let patch: EnemyPatch | null = null
    if (field === 'name') {
      const name = cleanEnemyName(value)
      if (name && name !== en.name) patch = { name }
    } else if (field === 'description') {
      const description = cleanDescription(value)
      if (description !== en.description) patch = { description }
    } else if (field === 'health' || field === 'mind') {
      const n = Number(value)
      if (value.trim() === '' || !Number.isFinite(n)) return null
      const v = Math.min(en.stats[field], Math.max(POOL_FLOOR, Math.round(n)))
      if (v !== en[field]) patch = { [field]: v }
    } else {
      const key = field === 'maxHealth' ? 'health' : field === 'maxMind' ? 'mind' : field
      if (!isEnemyStatKey(key)) return null
      const n = Number(value)
      if (value.trim() === '' || !Number.isFinite(n)) return null
      const v = clampStat(key, n)
      if (v !== en.stats[key]) patch = { stats: { [key]: v } }
    }
    return patch ? { type: 'enemy_updated', enemyId, patch, by } : null
  }

  /** −1 / +1 on an enemy's current Health or Mind (never above its max, never below the floor). */
  planAdjustPool(enemyId: string, pool: 'health' | 'mind', delta: number, by: string): EnemyEventData | null {
    const en = this.enemy(enemyId)
    if (!en || !Number.isFinite(delta)) return null
    const v = Math.min(en.stats[pool], Math.max(POOL_FLOOR, en[pool] + Math.round(delta)))
    return v === en[pool] ? null : { type: 'enemy_updated', enemyId, patch: { [pool]: v }, by }
  }

  planNextRound(by: string): EnemyEventData | null {
    return this.enemies.length ? { type: 'combat_round_started', by } : null
  }

  /** Remove some enemies — `'defeated'` (Health below 0), `'all'`, or a list of ids. */
  planRemove(which: 'defeated' | 'all' | string[], by: string): EnemyEventData | null {
    const ids =
      which === 'all'
        ? this.enemies.map((e) => e.id)
        : which === 'defeated'
          ? this.enemies.filter((e) => e.health < 0).map((e) => e.id)
          : which.filter((id) => this.enemy(id))
    return ids.length ? { type: 'enemies_removed', enemyIds: ids, by } : null
  }
}
