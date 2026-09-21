// Event log (SQLite) and the in-memory state rebuilt from it.
// Every change is an appended event; undo appends an "undo" event and rebuilds.
//
// Characters have two stages:
//   draft  — in creation. Edits overwrite a row in the `drafts` table and are NOT logged.
//   active — "Finish character" logs one character_finalized event holding the base values.
//            Play changes to base fields are stored as adjustments (current = base + adj),
//            so correcting a base value later keeps e.g. a −1 from poison.
import { Database } from 'bun:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { cryptoRng, evaluate } from './engine/expr'
import { computeScope, defaultValues, type Values } from './engine/sheet'
import { isBaseField, type Field, type NumberField, type Rules, type Trait } from './rules'

export { isBaseField }

export type Visibility = 'public' | 'gm' | 'hidden'

export type ChallengeStakes = 'low' | 'normal' | 'high'
/**
 * One ability's roll. `faces` are the raw d6 ids (1–6, what the face is *called*); `dice` are the
 * same faces shifted by (rank − 3) — the values that actually count. A strong character's "poor"
 * can therefore beat a weak character's "good". `faces` is optional: challenges rolled before it
 * was recorded only have the shifted values.
 */
export type ChallengeSide = { faces?: [number, number]; dice: [number, number]; sum: number }
export type Challenge = {
  id: string
  /** What the challenge is, in the GM's words — shown on every screen. */
  description: string
  mainAbility: string
  supportAbility: string
  mainDifficulty: number
  supportDifficulty: number
  stakes: ChallengeStakes
  charId: string | null
  approach: string | null
  /** A trained skill whose rank is split between the two sides (see the skillPoints fields). */
  skill: string | null
  mainSkillPoints: number
  supportSkillPoints: number
  /** Exertion: pool points burned (gained), how much was added to each side, and rerolls used. */
  exertionGained: number
  exertionMain: number
  exertionSupport: number
  rerolls: number
  /** The GM has accepted the result: nothing more can be spent or rerolled. */
  closed: boolean
  /** null until rolled. Once rolled, skill points can still change (see setChallengeSkillPoints). */
  main: ChallengeSide | null
  support: ChallengeSide | null
  by: string
}
/** One side's result against its target: difference, pass/fail, and stakes-scaled degrees
 *  (positive = boons, negative = complications; see outcomeFor()). */
export type SideOutcome = { sum: number; target: number; difference: number; success: boolean; degrees: number }
export type ChallengeOutcome = { main: SideOutcome; support: SideOutcome; success: boolean }

/**
 * Rolls one side: 2 d6, each face shifted by (rank − 3) — average (rank 3) is a plain d6, each
 * rank above/below shifts every face up/down by 1 (faces can go to 0 or below; abilities have
 * no fixed floor, see rules.ts). rank is rounded to the nearest whole number first.
 */
export function rollChallengeSide(rank: number, rng: () => number = () => cryptoRng(6)): ChallengeSide {
  const shift = Math.round(rank) - 3
  const faces: [number, number] = [rng(), rng()]
  const dice: [number, number] = [faces[0] + shift, faces[1] + shift]
  return { faces, dice, sum: dice[0] + dice[1] }
}

/** One replacement die (exertion reroll): raw face id plus the rank-shifted value. */
export function rollOneFace(rank: number, rng: () => number = () => cryptoRng(6)) {
  const face = rng()
  return { face, value: face + Math.round(rank) - 3 }
}

/**
 * One side's outcome against its target. Degrees scale with stakes: low never generates one;
 * normal grants exactly one (boon if the difference is +3 or more, complication if −3 or less);
 * high grants one per full 3 points beyond the target, in either direction.
 */
export function outcomeFor(sum: number, target: number, stakes: ChallengeStakes): SideOutcome {
  const difference = sum - target
  const success = difference >= 0
  let degrees = 0
  if (stakes === 'normal') degrees = Math.abs(difference) >= 3 ? Math.sign(difference) : 0
  else if (stakes === 'high') degrees = Math.sign(difference) * Math.floor(Math.abs(difference) / 3)
  return { sum, target, difference, success, degrees }
}

export type EventData =
  | { type: 'character_created'; charId: string; name: string }
  | { type: 'character_renamed'; charId: string; from: string; to: string; by: string }
  | { type: 'character_deleted'; charId: string; by: string }
  | { type: 'character_finalized'; charId: string; base: Record<string, number>; values: Values; traits: string[]; by: string }
  // For base fields of active characters, from/to are current values (base + adjustment).
  | { type: 'field_set'; charId: string; field: string; from: number | string; to: number | string; by: string }
  | { type: 'base_set'; charId: string; field: string; from: number; to: number; by: string }
  // Trait picked/dropped on an already-finished character. changes are the resulting values —
  // base for an ability modifier, skillPoints for a skill_points modifier (may shift its rank).
  // grantedPoints keeps pointsGranted in step with skill_points changes (net zero on the pool).
  | {
      type: 'trait_added'
      charId: string
      traitId: string
      changes: { field: string; from: number; to: number }[]
      grantedPoints: number
      by: string
    }
  | {
      type: 'trait_removed'
      charId: string
      traitId: string
      changes: { field: string; from: number; to: number }[]
      grantedPoints: number
      by: string
    }
  | { type: 'power_level_set'; value: number; from: number; by: string }
  // Play change to a calculated stat: adj is stored (current = formula + adj); from/to are shown values.
  | { type: 'stat_set'; charId: string; stat: string; adj: number; from: number; to: number; by: string }
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
  // Skill points: granted on finishing ("creation"), per level up ("level") or by hand ("gm").
  | { type: 'skill_points_granted'; charId: string; amount: number; reason: 'creation' | 'level' | 'gm'; by: string }
  // Training: points assigned to a trained field (from/to are point totals).
  | { type: 'skill_trained'; charId: string; skill: string; from: number; to: number; by: string }
  // Challenges (public-screen board): starting one, a player joining it (charId/approach/skill
  // all set together, any may be null), rolling it, then optionally re-splitting skill points.
  | {
      type: 'challenge_started'
      challengeId: string
      description: string
      mainAbility: string
      supportAbility: string
      mainDifficulty: number
      supportDifficulty: number
      stakes: ChallengeStakes
      by: string
    }
  | { type: 'challenge_player_set'; challengeId: string; charId: string | null; approach: string | null; skill: string | null; by: string }
  | { type: 'challenge_rolled'; challengeId: string; main: ChallengeSide; support: ChallengeSide; by: string }
  | { type: 'challenge_skill_points_set'; challengeId: string; mainSkillPoints: number; supportSkillPoints: number; by: string }
  // Exertion: burn a pool point for one exertion, then spend it on a side or on rerolling a die.
  | {
      type: 'challenge_exerted'
      challengeId: string
      charId: string
      stat: string
      adj: number
      from: number
      to: number
      by: string
    }
  | { type: 'challenge_exertion_spent'; challengeId: string; side: 'main' | 'support'; by: string }
  | {
      type: 'challenge_rerolled'
      challengeId: string
      side: 'main' | 'support'
      index: number
      face: number
      value: number
      by: string
    }
  | { type: 'challenge_closed'; challengeId: string; by: string }
  | { type: 'undo'; target: number; by: string }
  | { type: 'session_started'; by: string }

export type LoggedEvent = EventData & { id: number; ts: number }
export type RollEvent = Extract<LoggedEvent, { type: 'roll' }>
export type FieldSetEvent = Extract<LoggedEvent, { type: 'field_set' }>
export type SessionStartedEvent = Extract<LoggedEvent, { type: 'session_started' }>

export type Character = {
  id: string
  name: string
  status: 'draft' | 'active'
  /** Draft: every field. Active: non-base fields (base fields use base + adj). */
  values: Values
  base: Record<string, number>
  adj: Record<string, number>
  /** Active only: change applied to calculated stats (pools: negative = spent). */
  statAdj: Record<string, number>
  /** Permanent trait-driven shift to a derived stat's formula result (survives status changes). */
  statBonus: Record<string, number>
  /** Skill points assigned per trained field. */
  skillPoints: Record<string, number>
  /** Total skill points ever granted (available = granted − assigned). */
  pointsGranted: number
  /** 1 + number of level ups. */
  level: number
  /** Ids of traits currently picked, in pick order. */
  traits: string[]
}

const CHANGE_TYPES = new Set<EventData['type']>([
  'character_finalized',
  'field_set',
  'base_set',
  'stat_set',
  'skill_points_granted',
  'skill_trained',
  'trait_added',
  'trait_removed',
  'power_level_set',
  'undo',
  'character_renamed',
  'character_deleted',
  'session_started',
])

/** In play a modified base field may leave its declared max (e.g. a 5 buffed to 6); a field's own
 *  min still applies (-Infinity if it has none — see rules.ts), so this only raises the ceiling. */
export const PLAY_MAX = 99

/** Traits a character may pick (during creation or, if the GM allows it, later). */
export const MAX_TRAITS = 8

export const cleanName = (name: string) => name.trim().replace(/\s+/g, ' ').slice(0, 40)

type DraftData = {
  values: Values
  traits: string[]
  skillPoints: Record<string, number>
  pointsGranted: number
  statBonus: Record<string, number>
}

export class Session {
  readonly events: LoggedEvent[] = []
  readonly characters = new Map<string, Character>()
  /** Latest name of every character ever created, including deleted ones (for the change log). */
  readonly names = new Map<string, string>()
  /** GM's current budget target for trait costs; starts at the rules.yaml default. */
  powerLevel: number
  /** All challenges ever started, in order. The last one (if any) is the "current" one. */
  readonly challenges: Challenge[] = []
  private readonly undone = new Set<number>()
  /** Latest draft values per character in creation (mirrors the `drafts` table). */
  private readonly drafts = new Map<string, DraftData>()
  private readonly db: Database

  constructor(readonly rules: Rules, dbPath: string) {
    this.powerLevel = rules.powerLevel
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
    this.db.run(`CREATE TABLE IF NOT EXISTS drafts (
      char_id TEXT PRIMARY KEY,
      data TEXT NOT NULL,
      updated INTEGER NOT NULL
    )`)
    for (const row of this.db.query('SELECT char_id, data FROM drafts').all() as { char_id: string; data: string }[]) {
      const parsed = JSON.parse(row.data)
      // Older drafts (before trait picking existed) stored the values object directly.
      const data: DraftData = parsed.values
        ? { skillPoints: {}, pointsGranted: 0, statBonus: {}, ...parsed }
        : { values: parsed, traits: [], skillPoints: {}, pointsGranted: 0, statBonus: {} }
      this.drafts.set(row.char_id, data)
    }
    this.rebuild()
  }

  close() {
    this.db.close()
  }

  private saveDraft(c: Character) {
    const data: DraftData = {
      values: { ...c.values },
      traits: [...c.traits],
      skillPoints: { ...c.skillPoints },
      pointsGranted: c.pointsGranted,
      statBonus: { ...c.statBonus },
    }
    this.drafts.set(c.id, data)
    this.db
      .query('INSERT OR REPLACE INTO drafts (char_id, data, updated) VALUES (?, ?, ?)')
      .run(c.id, JSON.stringify(data), Date.now())
  }

  private dropDraft(charId: string) {
    this.drafts.delete(charId)
    this.db.query('DELETE FROM drafts WHERE char_id = ?').run(charId)
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
    this.names.clear()
    this.undone.clear()
    this.challenges.length = 0
    for (const e of this.events) if (e.type === 'undo') this.undone.add(e.target)
    for (const e of this.events) this.apply(e)
    // Draft edits aren't events; layer the saved draft on top.
    for (const c of this.characters.values()) {
      const draft = this.drafts.get(c.id)
      if (c.status === 'draft' && draft) {
        Object.assign(c.values, draft.values)
        c.traits = [...draft.traits]
        c.skillPoints = { ...draft.skillPoints }
        c.pointsGranted = draft.pointsGranted
        c.statBonus = { ...draft.statBonus }
      }
    }
  }

  private apply(e: LoggedEvent) {
    if (this.undone.has(e.id)) return
    switch (e.type) {
      case 'character_created':
        this.characters.set(e.charId, {
          id: e.charId,
          name: e.name,
          status: 'draft',
          values: defaultValues(this.rules),
          base: {},
          adj: {},
          statAdj: {},
          statBonus: {},
          skillPoints: {},
          pointsGranted: 0,
          level: 1,
          traits: [],
        })
        this.names.set(e.charId, e.name)
        break
      case 'character_finalized': {
        const c = this.characters.get(e.charId)
        if (c)
          Object.assign(c, {
            status: 'active',
            base: { ...e.base },
            values: { ...e.values },
            traits: [...e.traits],
            adj: {},
            statAdj: {},
          })
        break
      }
      case 'base_set': {
        const c = this.characters.get(e.charId)
        if (c?.status === 'active') c.base[e.field] = e.to
        break
      }
      case 'trait_added': {
        const c = this.characters.get(e.charId)
        if (!c) break
        for (const ch of e.changes) this.applyTraitChange(c, ch)
        c.pointsGranted += e.grantedPoints
        if (!c.traits.includes(e.traitId)) c.traits.push(e.traitId)
        break
      }
      case 'trait_removed': {
        const c = this.characters.get(e.charId)
        if (!c) break
        for (const ch of e.changes) this.applyTraitChange(c, ch)
        c.pointsGranted += e.grantedPoints
        c.traits = c.traits.filter((id) => id !== e.traitId)
        break
      }
      case 'power_level_set':
        this.powerLevel = e.value
        break
      case 'stat_set': {
        const c = this.characters.get(e.charId)
        if (c?.status === 'active') c.statAdj[e.stat] = e.adj
        break
      }
      case 'skill_points_granted': {
        const c = this.characters.get(e.charId)
        if (!c) break
        c.pointsGranted += e.amount
        if (e.reason === 'level') c.level += 1
        break
      }
      case 'skill_trained': {
        const c = this.characters.get(e.charId)
        if (c) c.skillPoints[e.skill] = e.to
        break
      }
      case 'character_renamed': {
        const c = this.characters.get(e.charId)
        if (c) c.name = e.to
        this.names.set(e.charId, e.to)
        break
      }
      case 'character_deleted':
        this.characters.delete(e.charId)
        break
      case 'field_set': {
        const c = this.characters.get(e.charId)
        const f = this.rules.fields.get(e.field)
        // Ignore fields that were removed from rules.yaml since the event was logged.
        if (!c || !f) break
        if (isBaseField(f) && c.status === 'active') c.adj[f.id] = Number(e.to) - this.baseOf(c, f)
        else c.values[f.id] = e.to
        break
      }
      case 'challenge_started':
        this.challenges.push({
          id: e.challengeId,
          description: e.description ?? '',
          mainAbility: e.mainAbility,
          supportAbility: e.supportAbility,
          mainDifficulty: e.mainDifficulty,
          supportDifficulty: e.supportDifficulty,
          stakes: e.stakes,
          charId: null,
          approach: null,
          skill: null,
          mainSkillPoints: 0,
          supportSkillPoints: 0,
          exertionGained: 0,
          exertionMain: 0,
          exertionSupport: 0,
          rerolls: 0,
          closed: false,
          main: null,
          support: null,
          by: e.by,
        })
        break
      case 'challenge_player_set': {
        const ch = this.challenges.find((x) => x.id === e.challengeId)
        if (ch) Object.assign(ch, { charId: e.charId, approach: e.approach, skill: e.skill })
        break
      }
      case 'challenge_rolled': {
        const ch = this.challenges.find((x) => x.id === e.challengeId)
        if (ch) Object.assign(ch, { main: e.main, support: e.support })
        break
      }
      case 'challenge_skill_points_set': {
        const ch = this.challenges.find((x) => x.id === e.challengeId)
        if (ch) Object.assign(ch, { mainSkillPoints: e.mainSkillPoints, supportSkillPoints: e.supportSkillPoints })
        break
      }
      case 'challenge_exerted': {
        const ch = this.challenges.find((x) => x.id === e.challengeId)
        const c = this.characters.get(e.charId)
        if (ch) ch.exertionGained += 1
        if (c?.status === 'active') c.statAdj[e.stat] = e.adj
        break
      }
      case 'challenge_exertion_spent': {
        const ch = this.challenges.find((x) => x.id === e.challengeId)
        if (!ch) break
        if (e.side === 'main') ch.exertionMain += 1
        else ch.exertionSupport += 1
        break
      }
      case 'challenge_rerolled': {
        const ch = this.challenges.find((x) => x.id === e.challengeId)
        const side = ch && ch[e.side]
        if (!ch || !side) break
        side.dice[e.index] = e.value
        if (side.faces) side.faces[e.index] = e.face
        side.sum = side.dice[0] + side.dice[1]
        ch.rerolls += 1
        break
      }
      case 'challenge_closed': {
        const ch = this.challenges.find((x) => x.id === e.challengeId)
        if (ch) ch.closed = true
        break
      }
    }
  }

  /** trait_added/trait_removed: a change targets base (ability), skillPoints (skill) or statBonus (derived). */
  private applyTraitChange(c: Character, ch: { field: string; to: number }) {
    const f = this.rules.fields.get(ch.field)
    if (!f) c.statBonus[ch.field] = ch.to
    else if ((f as NumberField).trained) c.skillPoints[ch.field] = ch.to
    else c.base[ch.field] = ch.to
  }

  isUndone(id: number) {
    return this.undone.has(id)
  }

  baseOf(c: Character, f: NumberField): number {
    if (f.trained) return this.rankOf(c.skillPoints[f.id] ?? 0)
    // Falls back to the stored value if the field was marked "base" after finishing.
    return c.base[f.id] ?? Number(c.values[f.id] ?? f.default)
  }

  /** Rank reached with this many skill points: number of thresholds met (4, 9, 15, …). */
  rankOf(points: number) {
    return this.rules.training?.thresholds.filter((t) => points >= t).length ?? 0
  }

  /** Skill points not yet assigned. Can be negative after a GM correction. */
  availablePoints(c: Character) {
    return c.pointsGranted - Object.values(c.skillPoints).reduce((a, b) => a + b, 0)
  }

  /** Points granted per level: the training points stat, from base values. */
  pointsPerLevel(c: Character) {
    const stat = this.rules.training?.pointsStat
    return stat ? Math.max(0, Math.round(this.scope(c.id, { base: true })[stat] ?? 0)) : 0
  }

  /** A based field's play ceiling: its own max, or PLAY_MAX if that's higher (room to be buffed). */
  private playMax(f: NumberField) {
    return Math.max(f.max, PLAY_MAX)
  }

  /** The value shown on the sheet and used by formulas. */
  valueOf(c: Character, f: Field): number | string {
    if (f.type === 'text') return String(c.values[f.id] ?? f.default)
    if (isBaseField(f) && c.status === 'active') {
      const current = this.baseOf(c, f) + (c.adj[f.id] ?? 0)
      return Math.min(this.playMax(f), Math.max(f.min, current))
    }
    if (isBaseField(f) && f.trained) return this.baseOf(c, f) // draft: untrained
    return Number(c.values[f.id] ?? f.default)
  }

  /** Values for formulas: current values, or with { base: true } base values (no play changes). */
  scope(charId: string, opts: { base?: boolean } = {}) {
    const c = this.characters.get(charId)
    if (!c) return {}
    const values: Values = {}
    for (const f of this.rules.fields.values()) {
      values[f.id] = opts.base && isBaseField(f) && c.status === 'active' ? this.baseOf(c, f) : this.valueOf(c, f)
    }
    return computeScope(this.rules, values)
  }

  /**
   * A calculated stat: `normal` is the formula result plus any permanent trait bonus (a pool's
   * maximum), `current` also includes temporary play changes. Formulas/rolls (scope()) use the
   * bare formula result, ignoring both — trait bonuses aren't wired into the formula engine yet,
   * so a derived stat referencing another one via a formula won't see its trait bonus.
   */
  statOf(c: Character, statId: string): { normal: number; current: number } | null {
    const d = this.rules.derived.find((x) => x.id === statId)
    if (!d) return null
    const raw = this.scope(c.id, { base: d.useBase })[statId] ?? NaN
    const normal = (Number.isFinite(raw) ? raw : 0) + (c.statBonus[statId] ?? 0)
    const shifted = normal + (c.status === 'active' && !d.useBase ? (c.statAdj[statId] ?? 0) : 0)
    const current = d.pool ? Math.min(normal, Math.max(0, shifted)) : Math.min(PLAY_MAX, Math.max(0, shifted))
    return { normal, current }
  }

  /** Sets a finished character's shown stat value (logged). Returns false if nothing changed. */
  setStat(charId: string, statId: string, value: number, by: string) {
    const c = this.characters.get(charId)
    const stat = c && this.statOf(c, statId)
    if (c?.status !== 'active' || !stat || !Number.isFinite(value)) return false
    const d = this.rules.derived.find((x) => x.id === statId)!
    if (d.useBase) return false
    const to = d.pool
      ? Math.min(stat.normal, Math.max(0, Math.round(value)))
      : Math.min(PLAY_MAX, Math.max(0, Math.round(value)))
    if (to === stat.current) return false
    this.append({ type: 'stat_set', charId, stat: statId, adj: to - stat.normal, from: stat.current, to, by })
    return true
  }

  adjustStat(charId: string, statId: string, delta: number, by: string) {
    const c = this.characters.get(charId)
    const stat = c && this.statOf(c, statId)
    return stat ? this.setStat(charId, statId, stat.current + delta, by) : false
  }

  createCharacter(name: string): Character {
    const charId = crypto.randomUUID().slice(0, 8)
    this.append({ type: 'character_created', charId, name: cleanName(name) || 'Nameless' })
    return this.characters.get(charId)!
  }

  /** Returns the event, or null if the character is missing or the name is unchanged/empty. */
  renameCharacter(charId: string, name: string, by: string) {
    const c = this.characters.get(charId)
    const to = cleanName(name)
    if (!c || !to || to === c.name) return null
    return this.append({ type: 'character_renamed', charId, from: c.name, to, by })
  }

  /** Removes the character from play. The history stays in the event log. */
  deleteCharacter(charId: string, by: string) {
    if (!this.characters.has(charId)) return null
    this.dropDraft(charId)
    return this.append({ type: 'character_deleted', charId, by })
  }

  /** Locks in the draft: base fields become base values. */
  finalizeCharacter(charId: string, by: string) {
    const c = this.characters.get(charId)
    if (c?.status !== 'draft') return null
    const base: Record<string, number> = {}
    for (const f of this.rules.fields.values()) if (isBaseField(f)) base[f.id] = Number(c.values[f.id] ?? f.default)
    const event = this.append({
      type: 'character_finalized',
      charId,
      base,
      values: { ...c.values },
      traits: [...c.traits],
      by,
    })
    this.dropDraft(charId)
    if (this.rules.training) {
      this.append({ type: 'skill_points_granted', charId, amount: this.pointsPerLevel(c), reason: 'creation', by })
    }
    return event
  }

  /** Level up: grants one level's worth of skill points. */
  levelUp(charId: string, by: string) {
    const c = this.characters.get(charId)
    if (c?.status !== 'active' || !this.rules.training) return false
    this.append({ type: 'skill_points_granted', charId, amount: this.pointsPerLevel(c), reason: 'level', by })
    return true
  }

  /** Manual grant (or removal, if negative) of skill points. */
  grantPoints(charId: string, amount: number, by: string) {
    const c = this.characters.get(charId)
    const n = Math.round(amount)
    if (c?.status !== 'active' || !this.rules.training || !Number.isFinite(n) || n === 0) return false
    this.append({ type: 'skill_points_granted', charId, amount: n, reason: 'gm', by })
    return true
  }

  /** Assigns (delta > 0) or takes back (delta < 0) skill points on a trained field. */
  train(charId: string, fieldId: string, delta: number, by: string) {
    const c = this.characters.get(charId)
    const f = this.rules.fields.get(fieldId)
    const t = this.rules.training
    if (c?.status !== 'active' || !t || !f || f.type !== 'number' || !f.trained || !Number.isFinite(delta)) return false
    const from = c.skillPoints[f.id] ?? 0
    // Can only spend what is available; taking points back is always allowed.
    const want = Math.round(delta)
    const step = want > 0 ? Math.min(want, this.availablePoints(c)) : want
    const to = Math.min(t.maxPoints, Math.max(0, from + step))
    if (to === from) return false
    this.append({ type: 'skill_trained', charId, skill: f.id, from, to, by })
    return true
  }

  /**
   * Sets the value shown on the sheet. Drafts are saved without logging.
   * Returns false if nothing changed.
   */
  setField(charId: string, fieldId: string, raw: string | number, by: string): boolean {
    const c = this.characters.get(charId)
    const f = this.rules.fields.get(fieldId)
    if (!c || !f) return false
    if (c.status === 'draft' && isBaseField(f) && f.trained) return false // trained after finishing
    const from = this.valueOf(c, f)
    let to: number | string
    if (f.type === 'text') {
      to = String(raw).slice(0, 5000)
    } else {
      const n = Math.round(Number(raw))
      if (!Number.isFinite(n)) return false
      const [min, max] =
        f.type === 'track'
          ? [0, f.max]
          : isBaseField(f) && c.status === 'active'
            ? [f.min, this.playMax(f)]
            : [f.min, f.max]
      to = Math.min(max, Math.max(min, n))
    }
    if (to === from) return false
    if (c.status === 'draft') {
      c.values[f.id] = to
      this.saveDraft(c)
    } else {
      this.append({ type: 'field_set', charId, field: fieldId, from, to, by })
    }
    return true
  }

  adjustField(charId: string, fieldId: string, delta: number, by: string) {
    const c = this.characters.get(charId)
    const f = this.rules.fields.get(fieldId)
    if (!c || !f || f.type === 'text') return false
    return this.setField(charId, fieldId, Number(this.valueOf(c, f)) + delta, by)
  }

  /** Changes the base value of a finished character (corrections, advancement). Logged. */
  adjustBase(charId: string, fieldId: string, delta: number, by: string) {
    const c = this.characters.get(charId)
    const f = this.rules.fields.get(fieldId)
    if (c?.status !== 'active' || !f || !isBaseField(f) || f.trained || !Number.isFinite(delta)) return false
    const from = this.baseOf(c, f)
    const to = Math.min(f.max, Math.max(f.min, from + Math.round(delta)))
    if (to === from) return false
    this.append({ type: 'base_set', charId, field: f.id, from, to, by })
    return true
  }

  /** Sum of the character's currently picked traits' costs, to compare against powerLevel. */
  traitCost(c: Character) {
    return c.traits.reduce((sum, id) => sum + (this.rules.traits.find((t) => t.id === id)?.cost ?? 0), 0)
  }

  /** The character's picked traits belonging to one category. */
  traitsInCategory(c: Character, categoryId: string): Trait[] {
    return c.traits.flatMap((id) => this.rules.traits.filter((t) => t.id === id && t.category === categoryId))
  }

  /** Union of tags across the character's currently picked traits. */
  pickedTags(c: Character): Set<string> {
    const tags = new Set<string>()
    for (const id of c.traits) {
      const t = this.rules.traits.find((tr) => tr.id === id)
      if (t) for (const tag of t.tags) tags.add(tag)
    }
    return tags
  }

  /**
   * A trait's modifiers as {field, from, to} changes, in the given direction (+1 add, -1 remove).
   * An ability modifier targets c.values (draft) or the base value (active); a skill_points
   * modifier always targets c.skillPoints directly; a stat_bonus modifier always targets
   * c.statBonus directly (unclamped — a derived stat has no declared range of its own).
   * grantedPoints is the actual (post-clamp) sum of skillPoints deltas, so pointsGranted can
   * move with it and the pool stays balanced.
   */
  private traitChanges(c: Character, trait: Trait, sign: 1 | -1) {
    const maxPoints = this.rules.training?.maxPoints ?? 0
    let grantedPoints = 0
    const changes = trait.modifiers.map((m) => {
      if (m.kind === 'skill_points') {
        const from = c.skillPoints[m.field] ?? 0
        const to = Math.min(maxPoints, Math.max(0, from + sign * m.points))
        grantedPoints += to - from
        return { field: m.field, from, to }
      }
      if (m.kind === 'stat_bonus') {
        const from = c.statBonus[m.stat] ?? 0
        return { field: m.stat, from, to: from + sign * m.delta }
      }
      const f = this.rules.fields.get(m.field) as NumberField
      const from = c.status === 'draft' ? Number(c.values[f.id] ?? f.default) : this.baseOf(c, f)
      const to = Math.min(f.max, Math.max(f.min, from + sign * m.delta))
      return { field: f.id, from, to }
    })
    return { changes, grantedPoints }
  }

  /** Draft equivalent of applyTraitChange: writes straight into values/skillPoints, not logged. */
  private applyDraftTraitChanges(c: Character, changes: { field: string; to: number }[], grantedPoints: number) {
    for (const ch of changes) {
      const f = this.rules.fields.get(ch.field) as NumberField | undefined
      if (!f) c.statBonus[ch.field] = ch.to
      else if (f.trained) c.skillPoints[ch.field] = ch.to
      else c.values[ch.field] = ch.to
    }
    c.pointsGranted += grantedPoints
  }

  /** Picks a trait, nudging its modifiers' fields. Draft: not logged. Active: adjusts base values. */
  addTrait(charId: string, traitId: string, by: string) {
    const c = this.characters.get(charId)
    const trait = this.rules.traits.find((t) => t.id === traitId)
    if (!c || !trait || c.traits.includes(traitId) || c.traits.length >= MAX_TRAITS) return false
    const category = this.rules.traitCategories.find((cat) => cat.id === trait.category)
    if (category && this.traitsInCategory(c, category.id).length >= category.max) return false
    if (trait.tags.some((tag) => this.pickedTags(c).has(tag))) return false
    const { changes, grantedPoints } = this.traitChanges(c, trait, 1)
    if (c.status === 'draft') {
      this.applyDraftTraitChanges(c, changes, grantedPoints)
      c.traits.push(traitId)
      this.saveDraft(c)
    } else {
      this.append({ type: 'trait_added', charId, traitId, changes, grantedPoints, by })
    }
    return true
  }

  /** Drops a picked trait, reversing its modifiers. */
  removeTrait(charId: string, traitId: string, by: string) {
    const c = this.characters.get(charId)
    const trait = this.rules.traits.find((t) => t.id === traitId)
    if (!c || !trait || !c.traits.includes(traitId)) return false
    const { changes, grantedPoints } = this.traitChanges(c, trait, -1)
    if (c.status === 'draft') {
      this.applyDraftTraitChanges(c, changes, grantedPoints)
      c.traits = c.traits.filter((id) => id !== traitId)
      this.saveDraft(c)
    } else {
      this.append({ type: 'trait_removed', charId, traitId, changes, grantedPoints, by })
    }
    return true
  }

  /** GM's target for trait cost balance. Not per-character, so not undoable. */
  setPowerLevel(value: number, by: string) {
    const n = Math.round(value)
    if (!Number.isFinite(n) || n === this.powerLevel) return false
    this.append({ type: 'power_level_set', value: n, from: this.powerLevel, by })
    return true
  }

  /** Undoes the character's most recent value, base or stat change that is still in effect. */
  undoLast(charId: string, by: string): LoggedEvent | null {
    for (let i = this.events.length - 1; i >= 0; i--) {
      const e = this.events[i]!
      const undoable =
        e.type === 'field_set' ||
        e.type === 'base_set' ||
        e.type === 'stat_set' ||
        e.type === 'skill_trained' ||
        e.type === 'trait_added' ||
        e.type === 'trait_removed' ||
        (e.type === 'skill_points_granted' && e.reason === 'level') // a mis-tapped Level up
      if (undoable && e.charId === charId && !this.undone.has(e.id)) {
        this.append({ type: 'undo', target: e.id, by })
        return e
      }
    }
    return null
  }

  /** The challenge currently on the public board, if any — always the most recently started. */
  currentChallenge(): Challenge | null {
    return this.challenges.at(-1) ?? null
  }

  private isAbilityField(id: string): id is string {
    const f = this.rules.fields.get(id)
    return !!f && isBaseField(f) && !f.trained
  }

  /** Starts a new challenge, becoming the current one (any previous one falls into history). */
  startChallenge(
    opts: {
      description: string
      mainAbility: string
      supportAbility: string
      mainDifficulty: number
      supportDifficulty: number
      stakes: ChallengeStakes
    },
    by: string,
  ) {
    if (!this.isAbilityField(opts.mainAbility) || !this.isAbilityField(opts.supportAbility)) return null
    if (!Number.isFinite(opts.mainDifficulty) || !Number.isFinite(opts.supportDifficulty)) return null
    const description = opts.description.trim().slice(0, 200)
    if (!description) return null // the GM names every challenge
    const challengeId = crypto.randomUUID().slice(0, 8)
    return this.append({
      type: 'challenge_started',
      challengeId,
      description,
      mainAbility: opts.mainAbility,
      supportAbility: opts.supportAbility,
      mainDifficulty: Math.round(opts.mainDifficulty),
      supportDifficulty: Math.round(opts.supportDifficulty),
      stakes: opts.stakes,
      by,
    })
  }

  /** Sets who's rolling and their approach/skill. Any of the three may be cleared with null. */
  setChallengePlayer(challengeId: string, charId: string | null, approach: string | null, skill: string | null, by: string) {
    const ch = this.challenges.find((x) => x.id === challengeId)
    if (!ch) return null
    if (charId !== null && !this.characters.has(charId)) return null
    if (approach !== null && !this.rules.challenges.approaches.some((a) => a.id === approach)) return null
    if (skill !== null) {
      const f = this.rules.fields.get(skill)
      if (!f || f.type !== 'number' || !f.trained) return null
    }
    return this.append({ type: 'challenge_player_set', challengeId, charId, approach, skill, by })
  }

  /** Rolls both sides for the joined player's current ability values. Once per challenge. */
  rollChallenge(challengeId: string, by: string) {
    const ch = this.challenges.find((x) => x.id === challengeId)
    if (!ch || !ch.charId || ch.main) return null
    const char = this.characters.get(ch.charId)
    if (!char) return null
    const mainRank = Number(this.valueOf(char, this.rules.fields.get(ch.mainAbility) as NumberField))
    const supportRank = Number(this.valueOf(char, this.rules.fields.get(ch.supportAbility) as NumberField))
    return this.append({
      type: 'challenge_rolled',
      challengeId,
      main: rollChallengeSide(mainRank),
      support: rollChallengeSide(supportRank),
      by,
    })
  }

  /** Re-splits the declared skill's rank between the two sides (each clamped to 0..rank). */
  setChallengeSkillPoints(challengeId: string, mainPoints: number, supportPoints: number, by: string) {
    const ch = this.challenges.find((x) => x.id === challengeId)
    if (!ch || !ch.main || !ch.skill || !ch.charId) return null
    const char = this.characters.get(ch.charId)
    const skillField = this.rules.fields.get(ch.skill) as NumberField | undefined
    if (!char || !skillField) return null
    const rank = Math.round(Number(this.baseOf(char, skillField)))
    const clamp = (n: number, max: number) => Math.max(0, Math.min(max, Math.round(Number(n) || 0)))
    const main = clamp(mainPoints, rank)
    const support = clamp(supportPoints, rank - main)
    if (main === ch.mainSkillPoints && support === ch.supportSkillPoints) return null
    return this.append({
      type: 'challenge_skill_points_set',
      challengeId,
      mainSkillPoints: main,
      supportSkillPoints: support,
      by,
    })
  }

  /** Full outcome (both sides + overall success) for a rolled challenge; null until rolled. */
  challengeOutcome(ch: Challenge): ChallengeOutcome | null {
    if (!ch.main || !ch.support) return null
    const main = outcomeFor(ch.main.sum + ch.mainSkillPoints + ch.exertionMain, ch.mainDifficulty, ch.stakes)
    const support = outcomeFor(
      ch.support.sum + ch.supportSkillPoints + ch.exertionSupport,
      ch.supportDifficulty,
      ch.stakes,
    )
    return { main, support, success: main.success && support.success }
  }

  /** Exertion earned but not yet spent on a side or a reroll. */
  availableExertion(ch: Challenge) {
    return ch.exertionGained - ch.exertionMain - ch.exertionSupport - ch.rerolls
  }

  /** The challenge's player, if it is rolled, open and theirs to act on. */
  private actingCharacter(challengeId: string, charId: string) {
    const ch = this.challenges.find((x) => x.id === challengeId)
    if (!ch || ch.closed || !ch.main || ch.charId !== charId) return null
    const char = this.characters.get(charId)
    return char?.status === 'active' ? { ch, char } : null
  }

  /** Burns one point of a pool stat (stamina/willpower) for one exertion. */
  exert(challengeId: string, charId: string, statId: string, by: string) {
    const acting = this.actingCharacter(challengeId, charId)
    if (!acting || !this.rules.challenges.exertionSources.includes(statId)) return false
    const stat = this.statOf(acting.char, statId)
    if (!stat || stat.current <= 0) return false
    const to = stat.current - 1
    this.append({
      type: 'challenge_exerted',
      challengeId,
      charId,
      stat: statId,
      adj: to - stat.normal,
      from: stat.current,
      to,
      by,
    })
    return true
  }

  /** Spends one exertion as +1 on one side's result. */
  spendExertion(challengeId: string, charId: string, side: 'main' | 'support', by: string) {
    const acting = this.actingCharacter(challengeId, charId)
    if (!acting || this.availableExertion(acting.ch) <= 0) return false
    this.append({ type: 'challenge_exertion_spent', challengeId, side, by })
    return true
  }

  /** Spends one exertion to reroll a single die, keeping the new face. */
  rerollDie(challengeId: string, charId: string, side: 'main' | 'support', index: number, by: string) {
    const acting = this.actingCharacter(challengeId, charId)
    if (!acting || this.availableExertion(acting.ch) <= 0) return false
    const { ch, char } = acting
    if (index !== 0 && index !== 1) return false
    const abilityId = side === 'main' ? ch.mainAbility : ch.supportAbility
    const field = this.rules.fields.get(abilityId) as NumberField | undefined
    if (!ch[side] || !field) return false
    const { face, value } = rollOneFace(Number(this.valueOf(char, field)))
    this.append({ type: 'challenge_rerolled', challengeId, side, index, face, value, by })
    return true
  }

  /** GM accepts the result: the challenge stops taking input. */
  closeChallenge(challengeId: string, by: string) {
    const ch = this.challenges.find((x) => x.id === challengeId)
    if (!ch || ch.closed || !ch.main) return false
    this.append({ type: 'challenge_closed', challengeId, by })
    return true
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

  /** Marks the start of a play session. The feed and change log only show what happened since. */
  startSession(by: string) {
    return this.append({ type: 'session_started', by }) as SessionStartedEvent
  }

  /** 1-based number of the current play session (0 before the first "start session"). */
  sessionNumber() {
    return this.events.filter((e) => e.type === 'session_started').length
  }

  private sinceSessionStart(): LoggedEvent[] {
    for (let i = this.events.length - 1; i >= 0; i--) {
      if (this.events[i]!.type === 'session_started') return this.events.slice(i)
    }
    return this.events
  }

  recentRolls(limit = 40): RollEvent[] {
    return this.sinceSessionStart()
      .filter((e): e is RollEvent => e.type === 'roll')
      .slice(-limit)
  }

  /**
   * Assigning skill points is noise in the log until it moves the rank, so only rank-changing
   * training events (and undos of them) are shown.
   */
  private worthLogging(e: LoggedEvent): boolean {
    if (!CHANGE_TYPES.has(e.type)) return false
    if (e.type === 'skill_trained') return this.rankOf(e.from) !== this.rankOf(e.to)
    if (e.type === 'undo') {
      const target = this.events.find((t) => t.id === e.target)
      return !target || this.worthLogging(target)
    }
    return true
  }

  recentChanges(limit = 40): LoggedEvent[] {
    return this.sinceSessionStart()
      .filter((e) => this.worthLogging(e))
      .slice(-limit)
  }
}
