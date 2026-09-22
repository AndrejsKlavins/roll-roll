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
import {
  approachEffect,
  effectCanActivate,
  effectPicks,
  effectStep,
  isBaseField,
  type Approach,
  type ApproachEffect,
  type Field,
  type NumberField,
  type Rules,
  type Trait,
} from './rules'

export { isBaseField }

export type Visibility = 'public' | 'gm' | 'hidden'

export type ChallengeStakes = 'low' | 'normal' | 'high'

/** Sides on the approach die: a plain d6, whatever the rolling ability's rank is. */
export const APPROACH_DIE_SIDES = 6
/**
 * One ability's roll. `faces` are the raw d6 ids (1–6, what the face is *called*); `dice` are the
 * same faces shifted by (rank − 3) — the values that actually count. A strong character's "poor"
 * can therefore beat a weak character's "good". `faces` is optional: challenges rolled before it
 * was recorded only have the shifted values.
 *
 * A side starts with two dice, but approach effects can add more (`extra_dice`) or stop one from
 * counting (`discard`), so these are plain arrays: `discarded[i]` keeps a discarded die visible
 * while leaving it out of `sum` (see sideSum), `rerolled[i]` counts how many times that die has
 * been rolled again (shown under it as "Reroll N") and `changed[i]` names an approach effect that
 * moved its face. All three are absent until something happens.
 */
/**
 * Why a die no longer shows what it was rolled as — named under it on the board.
 * 'raised'/'lowered' moved it one face, 'squashed' set it to a fixed face, 'matched' raised it to
 * the highest face on its own side, and 'copied' marks a twin an effect added.
 */
export type DieMarker = 'raised' | 'squashed' | 'lowered' | 'matched' | 'copied' | null
export type ChallengeSide = {
  faces?: number[]
  dice: number[]
  discarded?: boolean[]
  rerolled?: number[]
  changed?: DieMarker[]
  sum: number
}

/** A side's total: every die that has not been discarded. */
export function sideSum(side: ChallengeSide) {
  return side.dice.reduce((total, die, i) => (side.discarded?.[i] ? total : total + die), 0)
}
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
  /** The approach's own d6 (1–6), rolled with the ability dice. null until rolled / no approach. */
  approachDie: number | null
  /** The player pressed Activate on the approach die. */
  approachActivated: boolean
  /** Picks the activated effect is still waiting for (a die or an ability); 0 = nothing pending. */
  approachPicksLeft: number
  /** Dice already tapped for this effect, as "side:index" — no die may be picked twice. */
  approachPicked: string[]
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

/** One extra or replacement die (exertion reroll, approach effect): raw face id + shifted value. */
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
  // approachDie is absent on challenges rolled before approach dice existed (or with no approach).
  | { type: 'challenge_rolled'; challengeId: string; main: ChallengeSide; support: ChallengeSide; approachDie?: number; by: string }
  | { type: 'challenge_approach_activated'; challengeId: string; by: string }
  // GM debug tool: the approach die is forced onto a face, re-arming Activate (see setApproachDie).
  | { type: 'challenge_approach_die_set'; challengeId: string; die: number; by: string }
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
      /** 'approach' rerolls come from an approach die and cost no exertion (default: exertion). */
      source?: 'exertion' | 'approach'
      by: string
    }
  // Approach-die effects: one die stops counting, its face moves, or extra dice join one side.
  | { type: 'challenge_die_discarded'; challengeId: string; side: 'main' | 'support'; index: number; by: string }
  | {
      type: 'challenge_face_changed'
      challengeId: string
      side: 'main' | 'support'
      index: number
      /** The face id the die now shows, and its rank-shifted value. Equal to the old ones when
       *  the effect could not move it (e.g. raising a die already on the top face). */
      face: number
      value: number
      /** What to show under the die; null when nothing actually moved. */
      marker: DieMarker
      by: string
    }
  | {
      type: 'challenge_dice_added'
      challengeId: string
      side: 'main' | 'support'
      faces: number[]
      values: number[]
      /** What to show under each added die; absent for plain extra dice, which carry no marker. */
      markers?: DieMarker[]
      /** Set when the dice are copies: the index of the die they were copied from, so the pick
       *  is spent on it (`discard_double`). Absent for `extra_dice`, which picks an ability. */
      from?: number
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
          approachDie: null,
          approachActivated: false,
          approachPicksLeft: 0,
          approachPicked: [],
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
        if (ch) Object.assign(ch, { main: e.main, support: e.support, approachDie: e.approachDie ?? null })
        break
      }
      case 'challenge_approach_activated': {
        const ch = this.challenges.find((x) => x.id === e.challengeId)
        if (!ch) break
        ch.approachActivated = true
        // Effects that need targets wait for that many picks; the rest are done on activation.
        ch.approachPicksLeft = effectPicks(this.approachEffectOf(ch))
        break
      }
      case 'challenge_approach_die_set': {
        const ch = this.challenges.find((x) => x.id === e.challengeId)
        if (!ch) break
        // The new face gets a fresh Activate; effects already applied stay on the ability dice.
        Object.assign(ch, { approachDie: e.die, approachActivated: false, approachPicksLeft: 0, approachPicked: [] })
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
        side.rerolled = side.rerolled ?? side.dice.map(() => 0)
        side.rerolled[e.index] = (side.rerolled[e.index] ?? 0) + 1
        side.sum = sideSum(side)
        // An approach reroll is free; only exertion rerolls count against what was burned.
        if (e.source === 'approach') this.spendApproachPick(ch, e.side, e.index)
        else ch.rerolls += 1
        break
      }
      case 'challenge_die_discarded': {
        const ch = this.challenges.find((x) => x.id === e.challengeId)
        const side = ch && ch[e.side]
        if (!ch || !side) break
        side.discarded = side.discarded ?? side.dice.map(() => false)
        side.discarded[e.index] = true
        side.sum = sideSum(side)
        this.spendApproachPick(ch, e.side, e.index)
        break
      }
      case 'challenge_face_changed': {
        const ch = this.challenges.find((x) => x.id === e.challengeId)
        const side = ch && ch[e.side]
        if (!ch || !side) break
        side.dice[e.index] = e.value
        if (side.faces) side.faces[e.index] = e.face
        side.changed = side.changed ?? side.dice.map(() => null)
        side.changed[e.index] = e.marker
        side.sum = sideSum(side)
        this.spendApproachPick(ch, e.side, e.index)
        break
      }
      case 'challenge_dice_added': {
        const ch = this.challenges.find((x) => x.id === e.challengeId)
        const side = ch && ch[e.side]
        if (!ch || !side) break
        // A marked die (a copy) needs the `changed` array even if nothing had moved before.
        if (e.markers?.some(Boolean)) side.changed = side.changed ?? side.dice.map(() => null)
        side.dice.push(...e.values)
        if (side.faces) side.faces.push(...e.faces)
        if (side.discarded) side.discarded.push(...e.values.map(() => false))
        if (side.rerolled) side.rerolled.push(...e.values.map(() => 0))
        if (side.changed) side.changed.push(...e.values.map((_, i) => e.markers?.[i] ?? null))
        side.sum = sideSum(side)
        // Copies are picked by tapping a die, so that die is spent; extra dice pick an ability.
        if (e.from !== undefined) this.spendApproachPick(ch, e.side, e.from)
        else ch.approachPicksLeft = Math.max(0, ch.approachPicksLeft - 1)
        break
      }
      case 'challenge_closed': {
        const ch = this.challenges.find((x) => x.id === e.challengeId)
        if (ch) ch.closed = true
        break
      }
    }
  }

  /** One pick of an approach effect is used up on that die; a die is never picked twice. */
  private spendApproachPick(ch: Challenge, side: 'main' | 'support', index: number) {
    ch.approachPicksLeft = Math.max(0, ch.approachPicksLeft - 1)
    ch.approachPicked.push(`${side}:${index}`)
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
      // The approach die is a plain d6 — no rank shift; what its face does is in rules.yaml.
      approachDie: ch.approach ? cryptoRng(APPROACH_DIE_SIDES) : undefined,
      by,
    })
  }

  /** The configured effect of the face this challenge's approach die landed on, if any. */
  private approachEffectOf(ch: Challenge) {
    const approach = ch.approach ? this.rules.challenges.approaches.find((a) => a.id === ch.approach) : null
    return approach && ch.approachDie !== null ? approachEffect(approach, ch.approachDie) : null
  }

  /**
   * How the approach die stands right now. Nothing applies by itself — the player presses
   * Activate — and `when` decides whether that button is offered at all:
   * - `always` (Limitless): as soon as it is rolled.
   * - `failure` (Unbreakable): only while the roll fails, i.e. at least one side is short of its
   *   target. A successful roll `skips` it, and that flips live as the sums change — but once
   *   activated the die stays `active`, so an effect that turns the roll into a success (raising
   *   dice, say) doesn't grey out the very thing that caused it.
   * - `choice` (Exquisite): whenever the player likes.
   *
   * `effect` is what this face does (null when the approach has none configured), `canActivate`
   * says whether the button belongs on screen, and `picksLeft` counts the dice (or the one
   * ability) an activated effect is still waiting for.
   * Returns null when nothing was rolled (no approach, or a pre-approach-die challenge).
   */
  approachState(ch: Challenge): {
    approach: Approach
    die: number
    status: 'active' | 'ready' | 'skipped'
    effect: ApproachEffect | null
    canActivate: boolean
    pending: boolean
    picksLeft: number
    /** Which pick of a two-step effect is outstanding; always 'first' for single-pick kinds. */
    step: 'first' | 'second'
    /** The side a two-step effect's first pick landed on — `discard_double`'s second pick must
     *  go on the other one. null until that first pick is made. */
    firstPickSide: 'main' | 'support' | null
  } | null {
    if (ch.approachDie === null || !ch.approach) return null
    const approach = this.rules.challenges.approaches.find((a) => a.id === ch.approach)
    if (!approach) return null
    const status = ch.approachActivated
      ? 'active'
      : approach.when === 'always'
        ? 'active'
        : approach.when === 'choice'
          ? 'ready'
          : this.challengeOutcome(ch)?.success
            ? 'skipped'
            : 'active'
    const effect = approachEffect(approach, ch.approachDie)
    // With effects configured the button applies one, so a blank face offers nothing. Without
    // them (Exquisite — effects still to come) only `choice` has a button at all.
    const worthActivating = approach.effects.length ? effectCanActivate(effect) : approach.when === 'choice'
    return {
      approach,
      die: ch.approachDie,
      status,
      effect,
      canActivate: worthActivating && !ch.approachActivated && status !== 'skipped',
      pending: ch.approachPicksLeft > 0,
      picksLeft: ch.approachPicksLeft,
      step: effectStep(effect, ch.approachPicksLeft),
      firstPickSide: this.firstPickSide(ch),
    }
  }

  /**
   * Presses Activate on the approach die. Effects that need targets (a die to discard, reroll or
   * change, an ability for extra dice) leave that many `approachPicksLeft`; the rest are done
   * here. One way only, and never after the GM closes the challenge.
   */
  activateApproach(challengeId: string, charId: string, by: string) {
    const acting = this.actingCharacter(challengeId, charId)
    if (!acting) return false
    const state = this.approachState(acting.ch)
    if (!state?.canActivate) return false
    this.append({ type: 'challenge_approach_activated', challengeId, by })
    return true
  }

  /**
   * GM debug tool: forces the approach die onto `die` so a face's effect can be tried without
   * rolling for it. Only while the challenge is rolled, has an approach and is still open.
   * Activate is re-armed (as if the die had just landed on that face), but changes an earlier
   * activation already made to the ability dice — discards, rerolls, moved faces — stay: they
   * are rolled results, and the log keeps both events.
   */
  setApproachDie(challengeId: string, die: number, by: string) {
    const ch = this.challenges.find((x) => x.id === challengeId)
    if (!ch || ch.closed || !ch.main || !ch.approach) return false
    if (!Number.isInteger(die) || die < 1 || die > APPROACH_DIE_SIDES) return false
    this.append({ type: 'challenge_approach_die_set', challengeId, die, by })
    return true
  }

  /** The pending approach effect, if it is one of `kinds`, with the acting player — or null. */
  private pendingEffect(challengeId: string, charId: string, kinds: ApproachEffect['kind'][]) {
    const acting = this.actingCharacter(challengeId, charId)
    if (!acting || acting.ch.approachPicksLeft <= 0) return null
    const effect = this.approachEffectOf(acting.ch)
    return effect && kinds.includes(effect.kind) ? { ...acting, effect } : null
  }

  /**
   * A die that is on the board and still counting. A side is not a fixed pair — `extra_dice` and
   * `discard_double` grow it — so the index is checked against what the side actually holds now.
   */
  private dieInPlay(ch: Challenge, side: 'main' | 'support', index: number) {
    const rolled = ch[side]
    if (!rolled || !Number.isInteger(index) || index < 0 || index >= rolled.dice.length) return null
    return rolled.discarded?.[index] ? null : rolled // discarded dice are out of play
  }

  /** A die the effect may still be pointed at: in play, and not already picked. */
  private pickableDie(ch: Challenge, side: 'main' | 'support', index: number) {
    const rolled = this.dieInPlay(ch, side, index)
    if (!rolled) return null
    return ch.approachPicked.includes(`${side}:${index}`) ? null : rolled // one pick per die
  }

  /**
   * Whether Tweak (`lower_raise`) may be pointed at this die right now. On top of being pickable,
   * the die must have somewhere to go: **a die on the worst face cannot be lowered and one on the
   * best face cannot be raised** (user decision), because that tap would spend the pick and move
   * nothing. The board asks this before making a die a button, so those dice are never offered.
   *
   * Only Tweak works this way — `raise_face` (Unbreakable) still spends its pick on a top-face die
   * by an earlier decision, and its prompt counts those taps down.
   */
  tweakableDie(ch: Challenge, side: 'main' | 'support', index: number) {
    if (!this.pickableDie(ch, side, index)) return false
    const face = ch[side]?.faces?.[index]
    if (face === undefined) return false // pre-`faces` challenges have no face to compare
    const { faces } = this.rules.challenges
    if (faces.length === 0) return true // no faces configured, so nothing to be at the end of
    return this.stepOf(ch) === 'first' ? face > faces[0]!.value : face < faces.at(-1)!.value
  }

  /** Whether any die on the board is still a legal target for Tweak's current step. */
  anyTweakableDie(ch: Challenge) {
    return (['main', 'support'] as const).some((side) =>
      (ch[side]?.dice ?? []).some((_, index) => this.tweakableDie(ch, side, index)),
    )
  }

  /**
   * Approach effect: the tapped die stops counting (it stays on screen, struck through).
   * Also the **first** step of `discard_double`, whose second step copies a die on the other side.
   */
  discardDie(challengeId: string, charId: string, side: 'main' | 'support', index: number, by: string) {
    const pending = this.pendingEffect(challengeId, charId, ['discard', 'discard_double'])
    if (!pending || !this.pickableDie(pending.ch, side, index)) return false
    // discard_double discards on its first pick only; the second one is the copy.
    if (pending.effect.kind === 'discard_double' && this.stepOf(pending.ch) !== 'first') return false
    this.append({ type: 'challenge_die_discarded', challengeId, side, index, by })
    return true
  }

  /** Which step of a two-step approach effect this challenge is waiting on. */
  private stepOf(ch: Challenge) {
    return effectStep(this.approachEffectOf(ch), ch.approachPicksLeft)
  }

  /** The side a two-step effect's first pick was made on ("side:index"), or null before it. */
  private firstPickSide(ch: Challenge): 'main' | 'support' | null {
    const key = ch.approachPicked[0]
    return key?.startsWith('main:') ? 'main' : key?.startsWith('support:') ? 'support' : null
  }

  /** Approach effect: the tapped die is rolled again, free of exertion. */
  approachReroll(challengeId: string, charId: string, side: 'main' | 'support', index: number, by: string) {
    const pending = this.pendingEffect(challengeId, charId, ['reroll'])
    if (!pending || !this.pickableDie(pending.ch, side, index)) return false
    const field = this.rules.fields.get(side === 'main' ? pending.ch.mainAbility : pending.ch.supportAbility) as
      | NumberField
      | undefined
    if (!field) return false
    const { face, value } = rollOneFace(Number(this.valueOf(pending.char, field)))
    this.append({ type: 'challenge_rerolled', challengeId, side, index, face, value, source: 'approach', by })
    return true
  }

  /**
   * Approach effect: the tapped die's face moves — one step up (`raise_face`) or onto a fixed
   * face (`set_face`). The rank shift is taken from the die itself, so the new value stays in
   * step with how that die was rolled. A raise that can't go higher still spends the pick, and
   * the die then carries no marker because nothing moved.
   */
  changeDieFace(challengeId: string, charId: string, side: 'main' | 'support', index: number, by: string) {
    const pending = this.pendingEffect(challengeId, charId, ['raise_face', 'set_face', 'lower_raise'])
    const rolled = pending && this.pickableDie(pending.ch, side, index)
    if (!pending || !rolled?.faces) return false // pre-`faces` challenges have no face to move
    const was = rolled.faces[index]!
    const { kind } = pending.effect
    // Tweak (`lower_raise`) lowers on its first pick and raises on its second, and refuses a die
    // that is already at the end it would move toward (see tweakableDie).
    if (kind === 'lower_raise' && !this.tweakableDie(pending.ch, side, index)) return false
    const lowering = kind === 'lower_raise' && this.stepOf(pending.ch) === 'first'
    const face = lowering
      ? Math.max(this.bottomFace(was), was - 1)
      : kind === 'set_face'
        ? pending.effect.toFace
        : Math.min(this.topFace(was), was + 1)
    const shift = rolled.dice[index]! - was
    const moved: DieMarker = lowering ? 'lowered' : kind === 'set_face' ? 'squashed' : 'raised'
    const marker: DieMarker = face === was ? null : moved
    this.append({ type: 'challenge_face_changed', challengeId, side, index, face, value: face + shift, marker, by })
    return true
  }

  /** Best/worst configured face ids; `fallback` covers rules with no faces listed at all. */
  private topFace = (fallback: number) => this.rules.challenges.faces.at(-1)?.value ?? fallback
  private bottomFace = (fallback: number) => this.rules.challenges.faces[0]?.value ?? fallback

  /**
   * Approach effect `match_highest` (Perfect balance): the player picks an ability, and that
   * side's **lowest** die rises to the face of its **highest**. Discarded dice are out of it on
   * both counts. A side whose dice already match spends the pick with nothing moved (like a raise
   * on the top face); a side with nothing in play cannot be picked at all.
   */
  matchHighestDie(challengeId: string, charId: string, side: 'main' | 'support', by: string) {
    const pending = this.pendingEffect(challengeId, charId, ['match_highest'])
    const rolled = pending?.ch[side]
    if (!pending || !rolled?.faces) return false // pre-`faces` challenges have no face to move
    const inPlay = rolled.faces.flatMap((face, i) => (rolled.discarded?.[i] ? [] : [{ face, i }]))
    if (inPlay.length === 0) return false
    const lowest = inPlay.reduce((low, d) => (d.face < low.face ? d : low))
    const highest = inPlay.reduce((high, d) => (d.face > high.face ? d : high))
    const shift = rolled.dice[lowest.i]! - lowest.face
    const marker: DieMarker = highest.face === lowest.face ? null : 'matched'
    this.append({
      type: 'challenge_face_changed',
      challengeId,
      side,
      index: lowest.i,
      face: highest.face,
      value: highest.face + shift,
      marker,
      by,
    })
    return true
  }

  /**
   * Second step of `discard_double` (Perfect choice): a twin of the tapped die joins its side and
   * counts. It has to be on the **other** ability from the die discarded first — that is what
   * makes the face a choice — so a tap on the discarded side is refused.
   */
  duplicateDie(challengeId: string, charId: string, side: 'main' | 'support', index: number, by: string) {
    const pending = this.pendingEffect(challengeId, charId, ['discard_double'])
    const rolled = pending && this.pickableDie(pending.ch, side, index)
    if (!pending || !rolled?.faces) return false
    if (this.stepOf(pending.ch) !== 'second') return false // the discard comes first
    if (this.firstPickSide(pending.ch) === side) return false // the copy goes on the other ability
    this.append({
      type: 'challenge_dice_added',
      challengeId,
      side,
      faces: [rolled.faces[index]!],
      values: [rolled.dice[index]!],
      markers: ['copied'],
      from: index,
      by,
    })
    return true
  }

  /** Approach effect: extra dice for the ability the player picked, rolled at its rank. */
  addApproachDice(challengeId: string, charId: string, side: 'main' | 'support', by: string) {
    const pending = this.pendingEffect(challengeId, charId, ['extra_dice'])
    if (!pending || !pending.ch[side]) return false
    const field = this.rules.fields.get(side === 'main' ? pending.ch.mainAbility : pending.ch.supportAbility) as
      | NumberField
      | undefined
    if (!field) return false
    const rank = Number(this.valueOf(pending.char, field))
    const rolls = Array.from({ length: pending.effect.dice }, () => rollOneFace(rank))
    this.append({
      type: 'challenge_dice_added',
      challengeId,
      side,
      faces: rolls.map((r) => r.face),
      values: rolls.map((r) => r.value),
      by,
    })
    return true
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

  /**
   * Spends one exertion to reroll a single die, keeping the new face. **Any** die on the side is
   * fair game, including ones an approach effect added (which sit at index 2 and up) — only a
   * discarded die is out, since it no longer counts.
   */
  rerollDie(challengeId: string, charId: string, side: 'main' | 'support', index: number, by: string) {
    const acting = this.actingCharacter(challengeId, charId)
    if (!acting || this.availableExertion(acting.ch) <= 0) return false
    const { ch, char } = acting
    if (!this.dieInPlay(ch, side, index)) return false
    const abilityId = side === 'main' ? ch.mainAbility : ch.supportAbility
    const field = this.rules.fields.get(abilityId) as NumberField | undefined
    if (!field) return false
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
