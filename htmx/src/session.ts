// Event log (SQLite) and the in-memory state rebuilt from it.
// Every change is an appended event; undo appends an "undo" event and rebuilds.
//
// Characters have two stages:
//   draft  — in creation. Edits overwrite a row in the `drafts` table and are NOT logged.
//   active — "Finish character" logs one character_finalized event holding the base values.
//            Play changes to base fields are stored as adjustments (current = base + adj),
//            so correcting a base value later keeps e.g. a −1 from poison.
import { Database } from 'bun:sqlite'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  ACCURACY_STAT,
  DAMAGE_STAT,
  defence,
  glancingDrop,
  hitTargetOf,
  hitTier,
  isDefence,
  isWoundPool,
  pointsToNextTier,
  pointsToNextWound,
  woundsFor,
  type Defence,
  type HitTier,
  type WoundPool,
} from './combat'
import { Bestiary, isEnemyEvent, type EnemyEventData } from './enemies'
import { cryptoRng, evaluate } from './engine/expr'
import { computeScope, defaultValues, type Values } from './engine/sheet'
import {
  abilityRankRange,
  approachEffect,
  effectCanActivate,
  effectPicks,
  effectStep,
  framingRung,
  isBaseField,
  type Approach,
  type ApproachEffect,
  type Field,
  type FramingRung,
  type Icon,
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
export type DieMarker = 'raised' | 'squashed' | 'lowered' | 'matched' | 'copied' | 'set' | 'maxed' | null
export type ChallengeSide = {
  faces?: number[]
  dice: number[]
  discarded?: boolean[]
  rerolled?: number[]
  changed?: DieMarker[]
  sum: number
}

/** How far a circumstance modifier may be pushed in either direction. */
export const MAX_CIRCUMSTANCE = 5

/** A side's total: every die that has not been discarded. */
export function sideSum(side: ChallengeSide) {
  return side.dice.reduce((total, die, i) => (side.discarded?.[i] ? total : total + die), 0)
}

/** Which of a challenge's two rolls something applies to. */
export type ChallengeRoll = 'framing' | 'resolution'

/**
 * A standard challenge. The GM sets **one difficulty** for the whole thing, names the
 * **resolution** ability that decides it, and may also name a **framing** ability that colours
 * how it goes. Both are rolled **at the same time** and shown together (user decision).
 *
 * The GM's circumstance modifier is added to the difficulty, giving the number both rolls go
 * against; the player's declared skill is a **bonus on each rolled result** (user decision — it
 * used to come off the difficulty). The framing roll's margin then buffs the resolution roll's
 * own sum up or down the framing ladder (rules.yaml) — it used to move the resolution's target
 * instead, but a bonus on the roll reads the same either way and keeps both checks judged
 * against the one difficulty — and may add a complication. That is worked out live, so exertion
 * spent on the framing after the dice are down still moves the resolution's bonus.
 */
export type Challenge = {
  id: string
  /** What the challenge is, in the GM's words. Optional — a quick challenge needs no name. */
  description: string
  /** null when the GM skipped framing: the resolution check is the whole challenge. */
  framingAbility: string | null
  resolutionAbility: string
  /** The GM's one difficulty for the whole challenge, before skill and circumstance move it. */
  difficulty: number
  /**
   * The GM's circumstance modifier, set after the difficulty is chosen. It is **added to the
   * difficulty** (user decision): a plus raises the number to reach and so works against the
   * player, a minus lowers it. Always read it through challengeMath().
   */
  circumstance: number
  stakes: ChallengeStakes
  charId: string | null
  /** The approach acts on **both** rolls — framing and resolution — once its die has landed. */
  approach: string | null
  /** The approach's own d6 (1–6), rolled with the challenge's dice. null until then / no approach. */
  approachDie: number | null
  /** The player pressed Activate on the approach die. */
  approachActivated: boolean
  /** Dice the activated effect is still waiting to be tapped; 0 = nothing pending. */
  approachPicksLeft: number
  /** Dice already tapped for this effect, as "roll:index" — no die may be picked twice. */
  approachPicked: string[]
  /** A trained skill declared before the roll; its rank is a bonus on both rolled results. */
  skill: string | null
  /** Exertion: pool points burned (gained), how much was added to each roll, and rerolls used. */
  exertionGained: number
  exertionFraming: number
  exertionResolution: number
  rerolls: number
  /**
   * The player chose **Reroll a die** for their next point of exertion: the dice are tap targets
   * until one is rerolled (or they cancel). A point is only ever spent as +1 *or* a reroll, and
   * this is how the board knows which one the player picked.
   */
  exertionRerollArmed: boolean
  /**
   * The "custom" adjustment on each roll: the ±1 buttons the GM and the rolling player both have
   * (user decision). Added straight onto that roll's sum and shown in its breakdown as "Custom".
   */
  customFraming: number
  customResolution: number
  /** Other players helping out, added by the GM; each may roll one support die (see Supporter). */
  supporters: Supporter[]
  /**
   * Set on one participant's part of a group task (see GroupTask): no approach, no supporters,
   * no circumstance or separate close — the group task owns those.
   */
  groupId: string | null
  /** Set when this challenge is a player's attack on an enemy (see Attack); null otherwise. */
  attack: Attack | null
  /** Set when this challenge is a magic roll (see Magic); null otherwise. */
  magic: Magic | null
  /** The GM has accepted the result: nothing more can be spent or rerolled. */
  closed: boolean
  /**
   * Whether **either** roll — the framing (when there is one) or the resolution — was short of
   * its target the instant the dice landed, before any exertion, reroll or later circumstance
   * nudge could move it (user decision). `null` until rolled. This is what a `when: failure`
   * approach (Unbreakable) is gated on, not the live result: it decides once, right at the roll,
   * so boosting a failure into a success afterwards doesn't retroactively take the option away.
   */
  failingAtRoll: boolean | null
  /** Both are set by the one roll; `framing` stays null when the GM skipped it. */
  framing: ChallengeSide | null
  resolution: ChallengeSide | null
  by: string
  /** The id of the event that started it — orders challenges and solo rolls in one history log. */
  seq: number
}
/**
 * A player attacking an enemy (user-designed): a challenge whose **framing is the hit roll**
 * (against the enemy's Evasion — or 0 once it is spent this round) and whose **resolution is the
 * damage roll** (against its Physical resistance). The GM may point either roll at a different
 * defence, and the wounds at Mind instead of Health. The hit tier (combat.ts) does to the damage
 * roll what a framing rung does to a resolution, worked out live in challengeMath: +1/+2, the
 * highest damage die discarded (glancing), an extra damage die (critical — `critDie`, rolled with
 * the damage dice and only counted on a critical), or no damage at all (miss). Item Attack
 * accuracy / Attack damage add to the hit / damage. The wounds come off the enemy when the GM
 * finishes the attack (`applied`).
 */
export type Attack = {
  enemyId: string
  enemyName: string
  hitVs: Defence
  damageVs: Defence
  pool: WoundPool
  /** The enemy's defence numbers when the attack began — a later tweak of the enemy doesn't move them. */
  hitValue: number
  damageValue: number
  /** The enemy had already been attacked this round: an Evasion hit roll goes against 0. */
  evasionSpent: boolean
  critDie: { face: number; value: number } | null
  /** Wounds taken off the enemy when the GM finished the attack; null until then. */
  applied: number | null
}

/**
 * A magic roll (user-designed), by a player or an NPC — two steps, like an attack:
 * 1. **Magnitude** (the framing roll) against 0: every full 3 of the result is a **success**
 *    (+3 = 1, +7 = 2; floor(result / 3), never below 0).
 * 2. The caster **activates** some of those successes (1 … all of them), which sets the
 *    **control** roll's difficulty to 3 per activated success; control (the resolution roll) is
 *    then rolled and shown with its margin.
 * Both rolls can be exerted and hand-edited, and the approach die (rolled with the magnitude) can
 * be cashed in during either step — on whichever roll is open (the magnitude is locked once control
 * is rolled). An **NPC** caster has no sheet: the GM gives the two ranks outright and runs the
 * rolls (no exertion or approach — the GM's custom ± and Set die cover that).
 */
export type Magic = {
  /** Successes the caster activated for control; null until the control roll. */
  activated: number | null
  /** An NPC caster: name and the ranks the GM gave; null for a player. */
  npc: { name: string; magnitudeRank: number; controlRank: number } | null
}

/** Control difficulty per activated success. */
export const MAGIC_STEP = 3

/**
 * An enemy attacking a player (user-designed). No active defence yet, so it simply happens: the
 * enemy's to-hit dice + bonus against the player's Evasion (0 once spent this round), the hit
 * tier, the damage dice + bonus against their Physical resistance, and the wounds straight off
 * their Health (or Mind). Everything is rolled and settled when the GM presses the button, and
 * the event keeps every number, so the log reads the same forever after.
 */
export type EnemyAttack = {
  id: string
  seq: number
  enemyId: string
  enemyName: string
  charId: string
  charName: string
  hitVs: Defence
  damageVs: Defence
  pool: WoundPool
  hit: ChallengeSide
  hitBonus: number
  /** The number the hit roll went against (0 when the player's Evasion was spent). */
  hitTarget: number
  evasionSpent: boolean
  /** null on a miss (no damage roll). A glancing blow's dropped die is marked discarded. */
  damage: ChallengeSide | null
  critDie: { face: number; value: number } | null
  damageBonus: number
  damageTarget: number
  wounds: number
  /** The pool before and after — a sheet pool stops at 0, so `to` may be less than wounds say. */
  from: number
  to: number
}

/** What an enemy attack's numbers come to — the one place that arithmetic lives. */
export function enemyAttackMath(
  a: Pick<EnemyAttack, 'hit' | 'hitBonus' | 'hitTarget' | 'damage' | 'critDie' | 'damageBonus' | 'damageTarget'>,
) {
  const hitTotal = a.hit.sum + a.hitBonus
  const hitMargin = hitTotal - a.hitTarget
  const tier = hitTier(hitMargin)
  const damageTotal = a.damage ? sideSum(a.damage) + (a.critDie?.value ?? 0) + a.damageBonus + tier.damageBonus : null
  const damageMargin = damageTotal === null ? null : damageTotal - a.damageTarget
  return { hitTotal, hitMargin, tier, damageTotal, damageMargin, wounds: damageMargin === null ? 0 : woundsFor(damageMargin) }
}

/**
 * A group task (user-designed): the GM sets one difficulty (nudged ±1 before inviting), the
 * abilities and stakes, and who takes part. **Each participant rolls it like a regular challenge**
 * — framing and resolution against the same number, their own skill, exertion for +1 or a reroll —
 * but with **no approach die and no supporters**. Each participant's part is an ordinary Challenge
 * (with `groupId`), so all the challenge maths and exertion rules are the same ones. The summary is
 * the sum of everyone's resolution margins (groupTotal).
 */
export type GroupTask = {
  id: string
  seq: number
  description: string
  difficulty: number
  stakes: ChallengeStakes
  framingAbility: string | null
  resolutionAbility: string
  /** One challenge per participant, in the order the GM listed them. */
  members: Challenge[]
  closed: boolean
  by: string
}

/**
 * A player helping with someone else's challenge (user-designed). The GM adds them; once the dice
 * are in they may roll **one** die of one of their own abilities — at that ability's rank, like
 * any ability die — and it is added to the framing or the resolution, their pick. It costs them a
 * point of stamina or willpower, which **they take off their own sheet** (the app deducts nothing).
 */
export type Supporter = {
  charId: string
  /** Set once they have rolled: which check it went to, the ability, and the die itself. */
  roll: ChallengeRoll | null
  ability: string | null
  die: { face: number; value: number } | null
}

/** Who sees a solo roll. The GM always does; `public` also shows it on /table (never to players). */
export type SoloVisibility = 'gm' | 'public'

/**
 * A roll the GM makes alone — an NPC's attempt, a hidden check — with no character, no approach
 * and nobody to join it. The GM picks an opposition number off the difficulty ladder (nudging it
 * by 1s), picks the rank to roll at, and rolls: two dice shifted by (rank − 3), exactly as an
 * ability side is rolled. Private unless the GM says otherwise, and revealable afterwards.
 */
export type SoloRoll = {
  id: string
  /** What it is for, in the GM's words. Optional — a quick roll needs no label. */
  description: string
  /** The opposition number actually rolled against, after the GM's ±1 nudges. */
  difficulty: number
  /** The ladder tier the number came from, kept for naming it; null once it no longer matches. */
  tier: string | null
  rank: number
  roll: ChallengeSide
  visibility: SoloVisibility
  by: string
  /** The id of the event that rolled it — orders it among challenges in the history log. */
  seq: number
}

/** Which half of an opposition roll a contestant is. */
export type OppositionSide = 'a' | 'b'

/**
 * One contestant in an opposition roll: either a player's character or an NPC the GM rolls for.
 * Each rolls **two** checks, like a challenge (user decision): a **framing** check that sets up
 * how it goes, and a **resolution** check that decides it.
 *
 * A character's ranks are read off the sheet when it rolls (so a wound between setup and roll
 * counts); an NPC has no sheet, so the GM gives `framingRank`/`resolutionRank` outright and it
 * commits nothing. Committed bonuses are **hidden from the other side until both are ready** (user
 * decision), which is what makes Ready worth pressing.
 *
 * (Logged before the rename, these were core = resolution and support = framing; the reducer
 * reads the old names — see contestantFromLog.)
 */
export type Contestant = {
  /** null for an NPC. */
  charId: string | null
  /** The character's name, or the GM's label for an NPC. */
  name: string
  /** Ability field ids — a character rolls these; null on an NPC. */
  framingAbility: string | null
  resolutionAbility: string | null
  /** An NPC's flat ranks; null on a character, whose ranks come from the sheet. */
  framingRank: number | null
  resolutionRank: number | null
  /** Pool points burned before the roll, each worth +1 on the check it was put on. */
  exertionFraming: number
  exertionResolution: number
  /**
   * A trained skill declared before the roll. Its rank is added in full to **both** checks, as in a
   * challenge (user decision — it used to be split between them by hand); see oppositionSkillBonus.
   */
  skill: string | null
  /** Committing is over for this side. Both sides ready reveals the commitments and opens Roll. */
  ready: boolean
  framing: ChallengeSide | null
  resolution: ChallengeSide | null
}

/**
 * A head-to-head roll with no difficulty number: two contestants, each rolling a framing and a
 * resolution check, compared with each other. Player vs player, player vs NPC or NPC vs NPC.
 *
 * It runs in three phases — commit (bonuses in, hidden), roll (both ready), done — and **nothing
 * can be changed once the dice are in** (user decision): no rerolls, no late exertion, no
 * circumstance. Always high stakes, so the margin reads as degrees of victory.
 */
export type Opposition = {
  id: string
  /** What the contest is, in the GM's words. */
  description: string
  a: Contestant
  b: Contestant
  by: string
  /** The id of the event that started it — orders it in the history log. */
  seq: number
  /** The GM pressed "Complete opposition challenge": frozen, and gone from the players' screens. */
  closed: boolean
}

/** Where an opposition roll has got to. */
export type OppositionPhase = 'committing' | 'rolling' | 'done'

/** One of the two head-to-head comparisons, once both sides have rolled it. */
export type OppositionCheck = {
  aSum: number
  bSum: number
  /** aSum − bSum. */
  margin: number
  /** Who took this check; null when it is level. */
  winner: OppositionSide | null
}

/**
 * How an opposition roll came out — **the same shape as a challenge** (user decision). Each
 * side's framing margin is its framing total **against the other side's** (there is no difficulty
 * to beat), which picks a rung on the challenge framing ladder; that rung's bonus goes straight
 * onto that side's resolution total, and its boon/complication is that side's to keep. **The
 * resolution check decides**; a level one falls through to the framing margin rather than
 * throwing that away, and only a contest level on both is a tie — reported without a winner, for
 * the GM to rule on.
 */
export type OppositionOutcome = {
  /** Plain framing totals (dice + commitments). */
  framing: OppositionCheck
  /** Each side's rung off its own framing margin (a's is +margin, b's −margin). */
  rungs: { a: FramingRung | null; b: FramingRung | null }
  /** Resolution totals **with each side's rung bonus in**. */
  resolution: OppositionCheck
  winner: OppositionSide | null
  /** Which check named the winner; null on a tie. */
  decidedBy: 'resolution' | 'framing' | null
  /** Degrees of victory: one per full 3 points of the deciding check's margin (high stakes). */
  degrees: number
}

/** One side's result against its target: difference, pass/fail, and stakes-scaled degrees
 *  (positive = boons, negative = complications; see outcomeFor()). */
export type SideOutcome = { sum: number; target: number; difference: number; success: boolean; degrees: number }

/**
 * Everything a challenge's numbers add up to — the one place the arithmetic lives, so a skill,
 * a circumstance or a framing rung can never be applied twice or missed.
 */
export type ChallengeMath = {
  /** The GM's difficulty for the whole challenge, before anything moves it. */
  difficulty: number
  circumstance: number
  /** The declared skill's rank — a bonus **on each rolled result**, not a cut in the difficulty. */
  skillBonus: number
  skillLabel: string | null
  /** The declared skill's own icon, for the bonus chip beside the dice — not the ability's. */
  skillIcon: Icon | null
  /** Both rolls' number to beat: difficulty + circumstance. The framing rung no longer moves it —
   *  it buffs the resolution roll instead (see rungBonus). */
  target: number
  framing: SideOutcome | null
  /** The rung the framing margin landed on; null with no framing roll (or none configured). */
  rung: FramingRung | null
  /** What that rung adds straight into the resolution roll's sum (a plus helps, a minus hurts). */
  rungBonus: number
  /** Points still needed for the framing to reach the next rung up the ladder; null with no
   *  framing roll, or once it's already on the top rung. */
  framingPointsToNext: number | null
  resolution: SideOutcome | null
  /** Boons (positive) / complications (negative): the resolution's stakes **plus** the rung's. */
  degrees: number
  /** Points still needed for the resolution to visibly improve — a bare success if it's still
   *  failing, or its next degree breakpoint; null with no resolution roll, or once there is
   *  nothing higher stakes can grant left to reach (see pointsToImprove). */
  resolutionPointsToNext: number | null
  /** null until the dice are rolled. */
  success: boolean | null
  /** Only on an attack (see Attack): the hit tier and what it did to the damage, and the wounds. */
  attack?: AttackMath
  /** Only on a magic roll (see Magic). */
  magic?: MagicMath
}

export type MagicMath = {
  /** Successes on the magnitude so far (live: exertion on it can add one); null before it's rolled. */
  successes: number | null
  /** Points the magnitude still needs for one more success. */
  pointsToNextSuccess: number | null
  activated: number | null
  /** The control roll's difficulty: 3 per activated success (plus circumstance); null until chosen. */
  controlTarget: number | null
}

export type AttackMath = {
  /** Each roll's number to beat (the enemy's defence, spent Evasion as 0, plus circumstance). */
  hitTarget: number
  damageTarget: number
  /** What the attacker's enabled items add: Attack accuracy on the hit, Attack damage on the damage. */
  accuracy: number
  weapon: number
  /** null until rolled. */
  tier: HitTier | null
  /** Glancing: the damage die index that is discarded. */
  dropped: number | null
  /** Critical: the extra damage die's value. */
  critValue: number | null
  wounds: number
}

/** What the GM picks for one side of a new opposition roll (see Session.startOpposition). */
export type ContestantSetup = {
  charId?: string | null
  name?: string
  framingAbility?: string | null
  resolutionAbility?: string | null
  framingRank?: number | null
  resolutionRank?: number | null
}

/**
 * A fresh contestant from a logged `opposition_started` side (or a new one being built). Events
 * logged before the framing/resolution rename carry core = resolution and support = framing, so
 * both spellings are read; commitments and dice always start empty.
 */
function contestantFromLog(raw: Record<string, unknown>): Contestant {
  const pick = <T,>(...keys: string[]) => (keys.map((k) => raw[k]).find((v) => v !== undefined && v !== null) ?? null) as T | null
  return {
    charId: pick<string>('charId'),
    name: String(raw.name ?? ''),
    framingAbility: pick<string>('framingAbility', 'supportAbility'),
    resolutionAbility: pick<string>('resolutionAbility', 'coreAbility'),
    framingRank: pick<number>('framingRank', 'supportRank'),
    resolutionRank: pick<number>('resolutionRank', 'coreRank'),
    exertionFraming: 0,
    exertionResolution: 0,
    skill: null,
    ready: false,
    framing: null,
    resolution: null,
  }
}

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

/** `count` d6 at `rank` — an enemy's roll (a character's is always two: rollChallengeSide). */
export function rollDiceSide(count: number, rank: number, rng: () => number = () => cryptoRng(6)): ChallengeSide {
  const shift = Math.round(rank) - 3
  const faces = Array.from({ length: Math.max(1, Math.round(count)) }, () => rng())
  const dice = faces.map((f) => f + shift)
  return { faces, dice, sum: dice.reduce((a, b) => a + b, 0) }
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

/**
 * How many more points would visibly improve a result — reaching a bare success if it's still
 * failing, or its next degree breakpoint — shown above the result's own verdict so the player can
 * see how close the next one is. Whichever is closer wins: a deep complication on normal or high
 * stakes climbs out of it before it reaches plain success, so that's what counts as "next" there.
 * Null when there is nothing left to reach: low stakes grants no degree at all, so once it's
 * succeeding there's nothing further; normal stakes has only the one degree beyond a plain
 * success, so once that's reached there's nothing higher either.
 *
 * High/normal stakes' degrees (outcomeFor) truncate toward zero, which makes the "0 boons/
 * complications" tier five points wide (−2..2) on high stakes while every tier past it is only
 * three points wide — not an even grid — so the next degree is found by walking forward until it
 * actually changes, rather than assumed from a fixed spacing.
 */
export function pointsToImprove(difference: number, stakes: ChallengeStakes): number | null {
  const current = outcomeFor(difference, 0, stakes)
  const toSuccess = current.success ? null : -difference
  let toNextDegree: number | null = null
  // Low stakes never grants a degree; normal stakes has nothing above its one tier.
  if (stakes !== 'low' && !(stakes === 'normal' && current.degrees >= 1)) {
    for (let step = 1; step <= 15; step++) {
      if (outcomeFor(difference + step, 0, stakes).degrees > current.degrees) {
        toNextDegree = step
        break
      }
    }
  }
  if (toSuccess === null) return toNextDegree
  if (toNextDegree === null) return toSuccess
  return Math.min(toSuccess, toNextDegree)
}

export type EventData =
  | { type: 'character_created'; charId: string; name: string }
  | { type: 'character_renamed'; charId: string; from: string; to: string; by: string }
  | { type: 'character_deleted'; charId: string; by: string }
  // A character restored from a backup file: arrives finished, with its whole state.
  | { type: 'character_imported'; charId: string; snapshot: CharacterSnapshot; by: string }
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
  // The in-game clock after a change: game time (ms since Day 1 00:00) and whether it is running.
  // The event's own ts is the real moment it was set, so a running clock counts on from there.
  | { type: 'clock_set'; ms: number; running: boolean }
  // Equipment: a player (or the GM, for them) defines an item, discards it, or turns it off/on.
  // The name rides on every event so the change log can say which item.
  | { type: 'item_added'; charId: string; itemId: string; name: string; modifiers: ItemModifier[]; by: string }
  | { type: 'item_removed'; charId: string; itemId: string; name: string; by: string }
  | { type: 'item_enabled_set'; charId: string; itemId: string; name: string; enabled: boolean; by: string }
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
  // Challenges (public-screen board): starting one, a player being put on it (charId/approach/
  // skill all set together, any may be null), then the one roll that lands both checks.
  | {
      type: 'challenge_started'
      challengeId: string
      description: string
      /** null when the GM skipped framing — the resolution check is the whole challenge. */
      framingAbility: string | null
      resolutionAbility: string
      difficulty: number
      stakes: ChallengeStakes
      /** A player's attack on an enemy (see Attack), without what the roll and the finish add. */
      attack?: Omit<Attack, 'critDie' | 'applied'>
      /** A magic roll (see Magic): the NPC caster, if it isn't a player. */
      magic?: { npc: Magic['npc'] }
      by: string
    }
  | { type: 'challenge_player_set'; challengeId: string; charId: string | null; approach: string | null; skill: string | null; by: string }
  // Group task: set up in one go by the GM (one challenge id per participant), and closed in one go.
  | {
      type: 'group_task_started'
      groupId: string
      description: string
      difficulty: number
      stakes: ChallengeStakes
      framingAbility: string | null
      resolutionAbility: string
      members: { challengeId: string; charId: string }[]
      by: string
    }
  | { type: 'group_task_closed'; groupId: string; by: string }
  // Support: the GM adds (or removes) a helping player; the helper rolls their one die.
  | { type: 'challenge_supporter_added'; challengeId: string; charId: string; by: string }
  | { type: 'challenge_supporter_removed'; challengeId: string; charId: string; by: string }
  | {
      type: 'challenge_support_rolled'
      challengeId: string
      charId: string
      roll: ChallengeRoll
      ability: string
      face: number
      value: number
      by: string
    }
  // Both checks land together (user decision), so one event carries them: `framing` is absent on
  // a challenge with no framing ability, and `approachDie` when no approach was picked.
  | {
      type: 'challenge_rolled'
      challengeId: string
      framing?: ChallengeSide
      /** Absent on an attack: its first roll is the hit alone (the damage comes later). */
      resolution?: ChallengeSide
      approachDie?: number
      by: string
    }
  // An attack's second roll, once the player has settled the hit (see Attack): the damage dice
  // and the critical die (which only counts on a critical). The hit can't be changed after it.
  // A magic roll's second step: the successes the caster activated, and the control roll.
  | { type: 'magic_control_rolled'; challengeId: string; activated: number; resolution: ChallengeSide; by: string }
  | { type: 'attack_damage_rolled'; challengeId: string; resolution: ChallengeSide; critDie: { face: number; value: number }; by: string }
  | { type: 'challenge_approach_activated'; challengeId: string; by: string }
  // GM circumstance modifier. `value` is the whole new modifier, not a step, so a replay lands
  // on the same number however many times it was nudged.
  | { type: 'challenge_circumstance_set'; challengeId: string; value: number; by: string }
  // GM debug tool: the approach die is forced onto a face, re-arming Activate (see setApproachDie).
  | { type: 'challenge_approach_die_set'; challengeId: string; die: number; by: string }
  // Exertion: burn a pool point for one exertion, then spend it on a roll or on rerolling a die.
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
  | { type: 'challenge_exertion_spent'; challengeId: string; roll: ChallengeRoll; by: string }
  // The player picks "Reroll a die" for a point of exertion (armed), or backs out of it.
  | { type: 'challenge_exertion_reroll_armed'; challengeId: string; armed: boolean; by: string }
  // Hand edits by the GM or the rolling player: a roll's custom ±, stored as the whole new value
  // (like the circumstance), and a die set straight onto a chosen face.
  | { type: 'challenge_custom_set'; challengeId: string; roll: ChallengeRoll; value: number; by: string }
  | {
      type: 'challenge_die_set'
      challengeId: string
      roll: ChallengeRoll
      index: number
      /** The face id picked, and its value with the die's own rank shift kept. */
      face: number
      value: number
      by: string
    }
  | {
      type: 'challenge_rerolled'
      challengeId: string
      roll: ChallengeRoll
      index: number
      face: number
      value: number
      /** 'approach' rerolls come from an approach die and cost no exertion (default: exertion). */
      source?: 'exertion' | 'approach'
      by: string
    }
  // Approach-die effects: one die stops counting, its face moves, or extra dice join the roll.
  | { type: 'challenge_die_discarded'; challengeId: string; roll: ChallengeRoll; index: number; by: string }
  | {
      type: 'challenge_face_changed'
      challengeId: string
      roll: ChallengeRoll
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
      roll: ChallengeRoll
      faces: number[]
      values: number[]
      /** What to show under each added die; absent for plain extra dice, which carry no marker. */
      markers?: DieMarker[]
      /** Set when the dice are copies: the index of the die they were copied from, so the pick
       *  is spent on it (`discard_double`). Absent for `extra_dice`, which needs no pick. */
      from?: number
      by: string
    }
  // `wounds`: on an attack, what came off the enemy as the GM finished it.
  | { type: 'challenge_closed'; challengeId: string; wounds?: number; by: string }
  // An enemy attacks a player: rolled and settled in one go (see EnemyAttack). `adj` is the new
  // play change on the character's pool, like exertion's.
  | (Omit<EnemyAttack, 'id' | 'seq'> & { type: 'enemy_attacked'; attackId: string; adj: number; by: string })
  // Solo roll: the GM's own roll against a picked opposition number. One event carries the whole
  // thing (it is set up in a dialog and rolled in one go); visibility can be changed afterwards.
  | {
      type: 'solo_rolled'
      soloId: string
      description: string
      difficulty: number
      tier: string | null
      rank: number
      roll: ChallengeSide
      visibility: SoloVisibility
      by: string
    }
  | { type: 'solo_visibility_set'; soloId: string; visibility: SoloVisibility; by: string }
  // Opposition roll: set up by the GM, then each side commits, readies and rolls. `side` is
  // always 'a' or 'b'; `check` says which of a contestant's two rolls a bonus was put on.
  | {
      type: 'opposition_started'
      oppositionId: string
      description: string
      /** Read through contestantFromLog: older events carry core/support names. */
      a: Contestant
      b: Contestant
      by: string
    }
  | {
      type: 'opposition_exerted'
      oppositionId: string
      side: OppositionSide
      /** 'core' / 'support' on events logged before the rename (= resolution / framing). */
      check: ChallengeRoll | 'core' | 'support'
      charId: string
      stat: string
      adj: number
      from: number
      to: number
      by: string
    }
  | { type: 'opposition_skill_set'; oppositionId: string; side: OppositionSide; skill: string | null; by: string }
  | {
      type: 'opposition_skill_points_set'
      oppositionId: string
      side: OppositionSide
      framing?: number
      resolution?: number
      /** Before the rename: core = resolution, support = framing. */
      core?: number
      support?: number
      by: string
    }
  | { type: 'opposition_ready_set'; oppositionId: string; side: OppositionSide; ready: boolean; by: string }
  | { type: 'opposition_closed'; oppositionId: string; by: string }
  | {
      type: 'opposition_rolled'
      oppositionId: string
      side: OppositionSide
      framing?: ChallengeSide
      resolution?: ChallengeSide
      /** Before the rename: core = resolution, support = framing. */
      core?: ChallengeSide
      support?: ChallengeSide
      by: string
    }
  | { type: 'undo'; target: number; by: string }
  | { type: 'session_started'; by: string }
  // A line of the GM's own text in the table's history log (user decision).
  | { type: 'log_note_added'; noteId: string; text: string; by: string }
  // The GM's bestiary and the current encounter (see enemies.ts).
  | EnemyEventData

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
  /** Equipment the player (or the GM) has defined, in the order it was added. */
  items: Item[]
}

/**
 * One thing an item changes while it is enabled: `target` is a base number field (an ability or
 * a skill), a calculated stat, or an item-only stat (rules `equipment.item_stats`, e.g. Attack
 * damage — shown only on the item). `delta` is a whole number, plus or minus.
 */
export type ItemModifier = { target: string; delta: number }

/**
 * A piece of equipment (user-designed): a name and what it modifies. **Enabled** items add their
 * modifiers on top of everything else — a temporary bonus, never a base change, so steppers and
 * "reset" leave it alone (see itemBonus). Disabled ones stay on the sheet and give nothing.
 */
export type Item = { id: string; name: string; modifiers: ItemModifier[]; enabled: boolean }

/**
 * Everything that makes up a finished character, for backups (see backup.ts): exported to a CSV
 * a person can read, and imported back as a new character in one `character_imported` event.
 */
export type CharacterSnapshot = {
  name: string
  level: number
  pointsGranted: number
  /** Untrained base fields (abilities). */
  base: Record<string, number>
  /** Play changes on top of base (not including equipment). */
  adj: Record<string, number>
  /** Play changes to calculated stats (a pool's spent points are negative). */
  statAdj: Record<string, number>
  /** Permanent (trait-driven) shifts to calculated stats. */
  statBonus: Record<string, number>
  /** Skill points assigned per trained field. */
  skillPoints: Record<string, number>
  /** Non-base fields: text (bio, gear, notes), plain numbers (money) and tracks. */
  values: Values
  traits: string[]
  items: Item[]
}

/** At most this many modifiers on one item, and this big a bonus each — sanity limits only. */
export const MAX_ITEM_MODIFIERS = 12
export const MAX_ITEM_DELTA = 99

const CHANGE_TYPES = new Set<EventData['type']>([
  'character_finalized',
  'field_set',
  'base_set',
  'stat_set',
  'skill_points_granted',
  'skill_trained',
  'trait_added',
  'trait_removed',
  'item_added',
  'item_removed',
  'item_enabled_set',
  'power_level_set',
  'undo',
  'character_renamed',
  'character_deleted',
  'character_imported',
  'session_started',
])

/** In play a modified base field may leave its declared max (e.g. a 5 buffed to 6); a field's own
 *  min still applies (-Infinity if it has none — see rules.ts), so this only raises the ceiling. */
export const PLAY_MAX = 99

/** Traits a character may pick (during creation or, if the GM allows it, later). */
export const MAX_TRAITS = 8

/** How often the running server records that it is alive, and how stale that may get before a
 *  start-up counts as "the server was off" (longer than a `bun --hot` reload takes). */
export const ALIVE_EVERY_MS = 5_000
export const ALIVE_GRACE_MS = 30_000

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
  readonly soloRolls: SoloRoll[] = []
  readonly oppositions: Opposition[] = []
  /** All group tasks ever started, in order; the last one is on the board. */
  readonly groupTasks: GroupTask[] = []
  /** Enemy templates and the current encounter (GM's Bestiary screen). */
  readonly bestiary: Bestiary
  /** Every enemy attack on a player, in order (the table's history log shows them). */
  readonly enemyAttacks: EnemyAttack[] = []
  /** The GM's own lines in the table's history log, in order; `seq` places them in time. */
  readonly logNotes: { id: string; seq: number; text: string }[] = []
  /** In-game clock (table screen): game ms since Day 1 00:00 as of real time `at`. */
  clock = { ms: 0, running: false, at: 0 }
  /** When markAlive last ran (0 = not yet in this process). */
  private lastAlive = 0
  private readonly undone = new Set<number>()
  /** Latest draft values per character in creation (mirrors the `drafts` table). */
  private readonly drafts = new Map<string, DraftData>()
  private readonly db: Database
  /** Where the database lives; log imports write a safety copy of the old log here. */
  private readonly dataDir: string

  constructor(readonly rules: Rules, dbPath: string) {
    this.bestiary = new Bestiary(rules.enemies)
    this.dataDir = dirname(dbPath)
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
    this.db.run('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
    this.rebuild()
    // The server was off (or asleep) with the clock running: stop it at the last sign of life,
    // so the downtime doesn't count. A `bun --hot` reload is newer than the grace, so it runs on.
    const alive = Number(
      (this.db.query("SELECT value FROM meta WHERE key = 'alive'").get() as { value: string } | null)?.value ?? 0,
    )
    if (alive && Date.now() - alive > ALIVE_GRACE_MS) this.pauseClockAt(alive)
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
    this.soloRolls.length = 0
    this.oppositions.length = 0
    this.groupTasks.length = 0
    this.bestiary.reset()
    this.enemyAttacks.length = 0
    this.logNotes.length = 0
    // Replayed from the log like everything else (power_level_set), so start from the default.
    this.powerLevel = this.rules.powerLevel
    this.clock = { ms: 0, running: false, at: 0 }
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
          items: [],
        })
        this.names.set(e.charId, e.name)
        break
      case 'character_imported': {
        const snap = e.snapshot
        this.characters.set(e.charId, {
          id: e.charId,
          name: snap.name,
          status: 'active',
          values: { ...defaultValues(this.rules), ...snap.values },
          base: { ...snap.base },
          adj: { ...snap.adj },
          statAdj: { ...snap.statAdj },
          statBonus: { ...snap.statBonus },
          skillPoints: { ...snap.skillPoints },
          pointsGranted: snap.pointsGranted,
          level: snap.level,
          traits: [...snap.traits],
          items: snap.items.map((it) => ({ ...it, modifiers: it.modifiers.map((m) => ({ ...m })) })),
        })
        this.names.set(e.charId, snap.name)
        break
      }
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
      case 'item_added': {
        const c = this.characters.get(e.charId)
        if (c) c.items.push({ id: e.itemId, name: e.name, modifiers: e.modifiers.map((m) => ({ ...m })), enabled: true })
        break
      }
      case 'item_removed': {
        const c = this.characters.get(e.charId)
        if (c) c.items = c.items.filter((it) => it.id !== e.itemId)
        break
      }
      case 'item_enabled_set': {
        const item = this.characters.get(e.charId)?.items.find((it) => it.id === e.itemId)
        if (item) item.enabled = e.enabled
        break
      }
      case 'power_level_set':
        this.powerLevel = e.value
        break
      case 'clock_set':
        this.clock = { ms: e.ms, running: e.running, at: e.ts }
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
        // The shown value includes any item bonus; adj is only the play change on top of base.
        if (isBaseField(f) && c.status === 'active') c.adj[f.id] = Number(e.to) - this.baseOf(c, f) - this.itemBonus(c, f.id)
        else c.values[f.id] = e.to
        break
      }
      case 'challenge_started':
        // Challenges logged before the framing redesign carry two difficulties and no resolution
        // ability; there is no sensible way to read them as one, so they are dropped (user
        // decision: no migration). Their later events then find no challenge and do nothing.
        if (!e.resolutionAbility) break
        this.challenges.push({
          ...this.newChallenge({
            id: e.challengeId,
            seq: e.id,
            description: e.description ?? '',
            framingAbility: e.framingAbility ?? null,
            resolutionAbility: e.resolutionAbility,
            difficulty: e.difficulty,
            stakes: e.stakes,
            by: e.by,
          }),
          attack: e.attack ? { ...e.attack, critDie: null, applied: null } : null,
          magic: e.magic ? { activated: null, npc: e.magic.npc ?? null } : null,
        })
        break
      case 'group_task_started': {
        const members = e.members.map((m) => ({
          ...this.newChallenge({
            id: m.challengeId,
            seq: e.id,
            description: e.description ?? '',
            framingAbility: e.framingAbility,
            resolutionAbility: e.resolutionAbility,
            difficulty: e.difficulty,
            stakes: e.stakes,
            by: e.by,
          }),
          charId: m.charId,
          groupId: e.groupId,
        }))
        this.groupTasks.push({
          id: e.groupId,
          seq: e.id,
          description: e.description ?? '',
          difficulty: e.difficulty,
          stakes: e.stakes,
          framingAbility: e.framingAbility,
          resolutionAbility: e.resolutionAbility,
          members,
          closed: false,
          by: e.by,
        })
        break
      }
      case 'group_task_closed': {
        const g = this.groupTasks.find((x) => x.id === e.groupId)
        if (g) {
          g.closed = true
          for (const m of g.members) m.closed = true
        }
        break
      }
      case 'challenge_player_set': {
        const ch = this.challengeById(e.challengeId)
        if (ch) {
          Object.assign(ch, { charId: e.charId, approach: e.approach, skill: e.skill })
          // The rolling player can't also be their own supporter.
          ch.supporters = ch.supporters.filter((sp) => sp.charId !== e.charId)
        }
        break
      }
      case 'challenge_supporter_added': {
        const ch = this.challengeById(e.challengeId)
        if (ch && !ch.supporters.some((sp) => sp.charId === e.charId)) {
          ch.supporters.push({ charId: e.charId, roll: null, ability: null, die: null })
        }
        break
      }
      case 'challenge_supporter_removed': {
        const ch = this.challengeById(e.challengeId)
        if (ch) ch.supporters = ch.supporters.filter((sp) => sp.charId !== e.charId)
        break
      }
      case 'challenge_support_rolled': {
        const sp = this.challengeById(e.challengeId)?.supporters.find((x) => x.charId === e.charId)
        if (sp) Object.assign(sp, { roll: e.roll, ability: e.ability, die: { face: e.face, value: e.value } })
        break
      }
      case 'challenge_rolled': {
        const ch = this.challengeById(e.challengeId)
        if (ch) {
          Object.assign(ch, {
            framing: e.framing ?? null,
            resolution: e.resolution ?? null,
            approachDie: e.approachDie ?? null,
          })
          // The enemy has been attacked: its Evasion is spent for the rest of the round.
          if (ch.attack) this.bestiary.markAttacked('enemy', ch.attack.enemyId)
          // Exertion is still 0 at this instant (the roll is what unlocks spending it), so this
          // reads the same as the plain dice — no snapshot subtraction needed.
          const math = this.challengeMath(ch)
          ch.failingAtRoll = math.resolution?.success === false || math.framing?.success === false
        }
        break
      }
      case 'magic_control_rolled': {
        const ch = this.challengeById(e.challengeId)
        if (!ch?.magic) break
        ch.magic.activated = e.activated
        ch.resolution = e.resolution
        // Unbreakable's gate: a failure at the moment of either roll (the magnitude was judged as
        // it landed — no success — and the control is judged now).
        ch.failingAtRoll = ch.failingAtRoll || this.challengeMath(ch).resolution?.success === false
        break
      }
      case 'attack_damage_rolled': {
        const ch = this.challengeById(e.challengeId)
        if (!ch?.attack) break
        ch.resolution = e.resolution
        ch.attack.critDie = e.critDie
        // Unbreakable's gate: a failure at the moment of **either** roll (user decision) — the hit
        // was judged when it landed, the damage is judged now.
        ch.failingAtRoll = ch.failingAtRoll || this.challengeMath(ch).attack?.wounds === 0
        break
      }
      case 'challenge_approach_activated': {
        const ch = this.challengeById(e.challengeId)
        if (!ch) break
        ch.approachActivated = true
        // A pending effect owns the dice, so a reroll the player had chosen stands down.
        ch.exertionRerollArmed = false
        // Effects that need targets wait for that many picks; the rest are done on activation.
        // Extra dice ask which roll they join — unless framing was skipped and there is no choice.
        const effect = this.approachEffectOf(ch)
        ch.approachPicksLeft = effect?.kind === 'extra_dice' && this.rollsInPlay(ch).length < 2 ? 0 : effectPicks(effect)
        break
      }
      case 'challenge_approach_die_set': {
        const ch = this.challengeById(e.challengeId)
        if (!ch) break
        // The new face gets a fresh Activate; effects already applied stay on the ability dice.
        Object.assign(ch, { approachDie: e.die, approachActivated: false, approachPicksLeft: 0, approachPicked: [] })
        break
      }
      case 'challenge_circumstance_set': {
        const ch = this.challengeById(e.challengeId)
        if (ch) ch.circumstance = e.value
        break
      }
      case 'challenge_exerted': {
        const ch = this.challengeById(e.challengeId)
        const c = this.characters.get(e.charId)
        if (ch) ch.exertionGained += 1
        if (c?.status === 'active') c.statAdj[e.stat] = e.adj
        break
      }
      case 'challenge_exertion_spent': {
        const ch = this.challengeById(e.challengeId)
        if (!ch) break
        if (e.roll === 'framing') ch.exertionFraming += 1
        else ch.exertionResolution += 1
        break
      }
      case 'challenge_exertion_reroll_armed': {
        const ch = this.challengeById(e.challengeId)
        if (ch) ch.exertionRerollArmed = e.armed
        break
      }
      case 'challenge_custom_set': {
        const ch = this.challengeById(e.challengeId)
        if (ch) ch[e.roll === 'framing' ? 'customFraming' : 'customResolution'] = e.value
        break
      }
      case 'challenge_die_set': {
        const side = this.challengeById(e.challengeId)?.[e.roll]
        if (!side) break
        side.dice[e.index] = e.value
        if (side.faces) side.faces[e.index] = e.face
        side.changed = side.changed ?? side.dice.map(() => null)
        side.changed[e.index] = 'set'
        side.sum = sideSum(side)
        break
      }
      case 'challenge_rerolled': {
        const ch = this.challengeById(e.challengeId)
        const side = ch && ch[e.roll]
        if (!ch || !side) break
        side.dice[e.index] = e.value
        if (side.faces) side.faces[e.index] = e.face
        side.rerolled = side.rerolled ?? side.dice.map(() => 0)
        side.rerolled[e.index] = (side.rerolled[e.index] ?? 0) + 1
        side.sum = sideSum(side)
        // An approach reroll is free; only exertion rerolls count against what was burned.
        if (e.source === 'approach') this.spendApproachPick(ch, e.roll, e.index)
        else Object.assign(ch, { rerolls: ch.rerolls + 1, exertionRerollArmed: false })
        break
      }
      case 'challenge_die_discarded': {
        const ch = this.challengeById(e.challengeId)
        const side = ch && ch[e.roll]
        if (!ch || !side) break
        side.discarded = side.discarded ?? side.dice.map(() => false)
        side.discarded[e.index] = true
        side.sum = sideSum(side)
        this.spendApproachPick(ch, e.roll, e.index)
        break
      }
      case 'challenge_face_changed': {
        const ch = this.challengeById(e.challengeId)
        const side = ch && ch[e.roll]
        if (!ch || !side) break
        side.dice[e.index] = e.value
        if (side.faces) side.faces[e.index] = e.face
        side.changed = side.changed ?? side.dice.map(() => null)
        side.changed[e.index] = e.marker
        side.sum = sideSum(side)
        this.spendApproachPick(ch, e.roll, e.index)
        break
      }
      case 'challenge_dice_added': {
        const ch = this.challengeById(e.challengeId)
        const side = ch && ch[e.roll]
        if (!ch || !side) break
        // A marked die (a copy) needs the `changed` array even if nothing had moved before.
        if (e.markers?.some(Boolean)) side.changed = side.changed ?? side.dice.map(() => null)
        side.dice.push(...e.values)
        if (side.faces) side.faces.push(...e.faces)
        if (side.discarded) side.discarded.push(...e.values.map(() => false))
        if (side.rerolled) side.rerolled.push(...e.values.map(() => 0))
        if (side.changed) side.changed.push(...e.values.map((_, i) => e.markers?.[i] ?? null))
        side.sum = sideSum(side)
        // Copies are picked by tapping a die, so that die is spent; extra dice spend the choice
        // of roll (a no-op when framing was skipped and there was nothing to choose).
        if (e.from !== undefined) this.spendApproachPick(ch, e.roll, e.from)
        else if (ch.approachPicksLeft > 0) ch.approachPicksLeft = 0
        break
      }
      case 'challenge_closed': {
        const ch = this.challengeById(e.challengeId)
        if (ch) ch.closed = true
        if (ch?.attack) {
          ch.attack.applied = e.wounds ?? 0
          this.bestiary.wound(ch.attack.enemyId, ch.attack.pool, e.wounds ?? 0)
        }
        break
      }
      case 'log_note_added':
        this.logNotes.push({ id: e.noteId, seq: e.id, text: e.text })
        break
      case 'enemy_attacked': {
        const { type: _type, attackId, adj, by: _by, id, ts: _ts, ...rest } = e
        this.enemyAttacks.push({ ...rest, id: attackId, seq: id })
        const c = this.characters.get(e.charId)
        if (c?.status === 'active') c.statAdj[e.pool] = adj
        this.bestiary.markAttacked('char', e.charId)
        break
      }
      case 'solo_rolled':
        this.soloRolls.push({
          id: e.soloId,
          seq: e.id,
          description: e.description ?? '',
          difficulty: e.difficulty,
          tier: e.tier,
          rank: e.rank,
          roll: e.roll,
          visibility: e.visibility,
          by: e.by,
        })
        break
      case 'solo_visibility_set': {
        const solo = this.soloRolls.find((x) => x.id === e.soloId)
        if (solo) solo.visibility = e.visibility
        break
      }
      case 'opposition_started':
        this.oppositions.push({
          id: e.oppositionId,
          description: e.description ?? '',
          a: contestantFromLog(e.a),
          b: contestantFromLog(e.b),
          by: e.by,
          seq: e.id,
          closed: false,
        })
        break
      case 'opposition_closed': {
        const opp = this.oppositions.find((x) => x.id === e.oppositionId)
        if (opp) opp.closed = true
        break
      }
      case 'opposition_exerted': {
        const one = this.contestantOf(e.oppositionId, e.side)
        const c = this.characters.get(e.charId)
        if (one) {
          if (e.check === 'resolution' || e.check === 'core') one.exertionResolution += 1
          else one.exertionFraming += 1
        }
        if (c?.status === 'active') c.statAdj[e.stat] = e.adj
        break
      }
      case 'opposition_skill_set': {
        const one = this.contestantOf(e.oppositionId, e.side)
        if (one) one.skill = e.skill
        break
      }
      // Logged while the skill was split between the checks by hand; it now counts in full on
      // both, so an old split has nothing left to say.
      case 'opposition_skill_points_set':
        break
      case 'opposition_ready_set': {
        const one = this.contestantOf(e.oppositionId, e.side)
        if (one) one.ready = e.ready
        break
      }
      case 'opposition_rolled': {
        const one = this.contestantOf(e.oppositionId, e.side)
        if (one) {
          one.framing = e.framing ?? e.support ?? null
          one.resolution = e.resolution ?? e.core ?? null
        }
        break
      }
      default:
        if (isEnemyEvent(e)) this.bestiary.apply(e)
    }
  }

  /**
   * One pick of an approach effect is used up on that die; a die is never picked twice. Effects
   * that apply on Activate (extra_dice, match_highest) have no pick outstanding, so their events
   * pass through here without spending one.
   */
  private spendApproachPick(ch: Challenge, roll: ChallengeRoll, index: number) {
    if (ch.approachPicksLeft <= 0) return
    ch.approachPicksLeft -= 1
    ch.approachPicked.push(`${roll}:${index}`)
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
      const current = this.baseOf(c, f) + (c.adj[f.id] ?? 0) + this.itemBonus(c, f.id)
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
    const normal = (Number.isFinite(raw) ? raw : 0) + (c.statBonus[statId] ?? 0) + (d.useBase ? 0 : this.itemBonus(c, statId))
    const shifted = normal + (c.status === 'active' && !d.useBase ? (c.statAdj[statId] ?? 0) : 0)
    const current = d.pool ? Math.min(normal, Math.max(0, shifted)) : Math.min(PLAY_MAX, Math.max(0, shifted))
    return { normal, current }
  }

  // ---- equipment ------------------------------------------------------------
  /**
   * What the character's **enabled** items add to one target, summed (0 for a draft: equipment is
   * for finished characters). Applied on top of base + play change in valueOf / statOf, and to the
   * skill bonus a challenge or opposition uses — but never stored in adj, so the steppers and
   * "reset" work on the play change alone.
   */
  itemBonus(c: Character, target: string) {
    if (c.status !== 'active') return 0
    let sum = 0
    for (const item of c.items) {
      if (!item.enabled) continue
      for (const m of item.modifiers) if (m.target === target) sum += m.delta
    }
    return sum
  }

  /**
   * What an item may modify, grouped for the picker: abilities and skills (base number fields),
   * calculated stats (not base-only ones such as Max skill points), then the item-only stats.
   */
  itemTargets(): { group: string; id: string; label: string }[] {
    const numbers = [...this.rules.fields.values()].filter((f): f is NumberField => isBaseField(f))
    return [
      ...numbers.filter((f) => !f.trained).map((f) => ({ group: 'Abilities', id: f.id, label: f.label })),
      ...numbers.filter((f) => f.trained).map((f) => ({ group: 'Skills', id: f.id, label: f.label })),
      ...this.rules.derived.filter((d) => !d.useBase).map((d) => ({ group: 'Stats', id: d.id, label: d.label })),
      ...(this.rules.equipment?.itemStats ?? []).map((st) => ({ group: 'Item only', id: st.id, label: st.label })),
    ]
  }

  /** A target's label, for showing an item's modifiers. */
  itemTargetLabel(target: string) {
    return this.itemTargets().find((t) => t.id === target)?.label ?? target
  }

  /**
   * Defines a new item on a finished character — by the player, or by the GM giving it to them.
   * Needs a name (1–60 characters) and at least one modifier; each must name a known target
   * with a whole, non-zero change. It starts enabled.
   */
  addItem(charId: string, name: string, modifiers: ItemModifier[], by: string) {
    const c = this.characters.get(charId)
    if (c?.status !== 'active' || !this.rules.equipment) return null
    const clean = name.trim().replace(/\s+/g, ' ').slice(0, 60)
    if (!clean || !Array.isArray(modifiers) || modifiers.length === 0 || modifiers.length > MAX_ITEM_MODIFIERS) {
      return null
    }
    const targets = new Set(this.itemTargets().map((t) => t.id))
    const mods: ItemModifier[] = []
    for (const m of modifiers) {
      const delta = Number(m?.delta)
      if (!targets.has(String(m?.target)) || !Number.isInteger(delta) || delta === 0 || Math.abs(delta) > MAX_ITEM_DELTA) {
        return null
      }
      mods.push({ target: String(m.target), delta })
    }
    const itemId = crypto.randomUUID().slice(0, 8)
    this.append({ type: 'item_added', charId, itemId, name: clean, modifiers: mods, by })
    return itemId
  }

  /** "Discard item": the item and its bonuses are gone for good (Undo can bring it back). */
  removeItem(charId: string, itemId: string, by: string) {
    const item = this.characters.get(charId)?.items.find((it) => it.id === itemId)
    if (!item) return false
    this.append({ type: 'item_removed', charId, itemId, name: item.name, by })
    return true
  }

  /** "Disable item" toggle: a disabled item stays on the sheet but gives no bonuses. */
  setItemEnabled(charId: string, itemId: string, enabled: boolean, by: string) {
    const item = this.characters.get(charId)?.items.find((it) => it.id === itemId)
    if (!item || item.enabled === enabled) return false
    this.append({ type: 'item_enabled_set', charId, itemId, name: item.name, enabled, by })
    return true
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
    // A hidden skill (its section needs a trait they don't have) can't be trained — but points
    // already on it can always be taken back (say the trait was dropped since).
    if (delta > 0 && !this.fieldVisible(c, f.id)) return false
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

  /**
   * Whether this character has a section at all: one with `requires_traits` (e.g. Magical Skills
   * behind Mystical / Supernatural) only once they have picked one of those traits.
   */
  sectionVisible(c: Character, section: { requiresTraits: string[] }) {
    return section.requiresTraits.length === 0 || section.requiresTraits.some((t) => c.traits.includes(t))
  }

  /** Whether a field is on this character's sheet (and in their skill pickers) — see sectionVisible. */
  fieldVisible(c: Character, fieldId: string) {
    const section = this.rules.sections.find((s) => s.fields.some((f) => f.id === fieldId))
    return !section || this.sectionVisible(c, section)
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

  // ---- in-game clock -----------------------------------------------------
  /** Game time now, in ms since Day 1 00:00. */
  clockMs(now = Date.now()) {
    return this.clock.ms + (this.clock.running ? now - this.clock.at : 0)
  }

  /**
   * Records that the server is running now; call every ALIVE_EVERY_MS (see index.ts). A long gap
   * since the last call means the laptop slept: a running clock is paused where it went quiet
   * (returns true then).
   */
  markAlive(now = Date.now()) {
    const slept = this.lastAlive > 0 && now - this.lastAlive > ALIVE_GRACE_MS && this.clock.running
    if (slept) this.pauseClockAt(this.lastAlive)
    this.lastAlive = now
    this.db.query("INSERT OR REPLACE INTO meta (key, value) VALUES ('alive', ?)").run(String(now))
    return slept
  }

  /** Pauses a running clock as it stood at real time `at` (shutdown / last sign of life). */
  pauseClockAt(at = Date.now()) {
    if (!this.clock.running) return
    this.append({ type: 'clock_set', ms: this.clockMs(Math.max(at, this.clock.at)), running: false })
  }

  /** Pause a running clock, or resume a paused one. */
  toggleClock() {
    this.append({ type: 'clock_set', ms: this.clockMs(), running: !this.clock.running })
  }

  /** Move the clock by whole minutes (either way); it never goes before Day 1 00:00. */
  shiftClock(minutes: number) {
    const ms = Math.max(0, this.clockMs() + Math.round(minutes) * 60_000)
    this.append({ type: 'clock_set', ms, running: this.clock.running })
  }

  // ---- backups ------------------------------------------------------------
  /** A finished character's whole state, for export (see backup.ts). */
  snapshotOf(c: Character): CharacterSnapshot {
    const values: Values = {}
    for (const f of this.rules.fields.values()) if (!isBaseField(f)) values[f.id] = c.values[f.id] ?? f.default
    return {
      name: c.name,
      level: c.level,
      pointsGranted: c.pointsGranted,
      base: { ...c.base },
      adj: { ...c.adj },
      statAdj: { ...c.statAdj },
      statBonus: { ...c.statBonus },
      skillPoints: { ...c.skillPoints },
      values,
      traits: [...c.traits],
      items: c.items.map((it) => ({ ...it, modifiers: it.modifiers.map((m) => ({ ...m })) })),
    }
  }

  /**
   * Restores a character from a backup as a **new** finished character (a fresh id, so it never
   * clashes with one still in the game). The snapshot has already been checked against these
   * rules (backup.ts), so this only logs it. The GM does it; it shows in the change log.
   */
  importCharacter(snapshot: CharacterSnapshot, by: string) {
    const name = cleanName(snapshot.name)
    if (!name) return null
    const charId = crypto.randomUUID().slice(0, 8)
    this.append({ type: 'character_imported', charId, snapshot: { ...snapshot, name }, by })
    return this.characters.get(charId) ?? null
  }

  /**
   * The whole event log as JSON Lines — one event per line, `id` and `ts` included — which is
   * everything the game is: characters, rolls, challenges, the change log. importLog reads it back.
   */
  exportLog() {
    return this.events.map((e) => JSON.stringify(e)).join('\n') + '\n'
  }

  /**
   * Replaces the **whole** event log with one exported earlier, and rebuilds everything from it.
   * Every line must be an event with a whole-number id (strictly increasing), a timestamp and a
   * type; otherwise nothing is touched and the reason comes back. The log being replaced is first
   * written to `data/backup-<time>.jsonl`, so an import can itself be undone by importing that.
   * Drafts (characters in creation) are not in the log and stay as they are.
   */
  importLog(text: string): { ok: true; events: number; backup: string } | { ok: false; error: string } {
    const lines = text.split(/\r?\n/).filter((l) => l.trim())
    if (lines.length === 0) return { ok: false, error: 'The file has no events in it.' }
    const events: LoggedEvent[] = []
    for (const [i, line] of lines.entries()) {
      let e: unknown
      try {
        e = JSON.parse(line)
      } catch {
        return { ok: false, error: `Line ${i + 1} is not valid JSON.` }
      }
      const ev = e as { id?: unknown; ts?: unknown; type?: unknown }
      if (!ev || typeof ev !== 'object' || !Number.isInteger(ev.id) || typeof ev.ts !== 'number' || typeof ev.type !== 'string') {
        return { ok: false, error: `Line ${i + 1} is not an event (it needs an id, ts and type).` }
      }
      if (events.length && (ev.id as number) <= events.at(-1)!.id) {
        return { ok: false, error: `Line ${i + 1}: event ids must go up (got ${ev.id} after ${events.at(-1)!.id}).` }
      }
      events.push(e as LoggedEvent)
    }
    const backup = join(this.dataDir, `backup-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`)
    writeFileSync(backup, this.exportLog())
    const insert = this.db.query('INSERT INTO events (id, ts, type, data) VALUES (?, ?, ?, ?)')
    this.db.transaction(() => {
      this.db.run('DELETE FROM events')
      for (const e of events) {
        const { id, ts, ...data } = e
        insert.run(id, ts, e.type, JSON.stringify(data))
      }
    })()
    this.events.length = 0
    this.events.push(...events)
    this.rebuild()
    // The log was saved some time ago; its clock stops at its last event, not at "now".
    this.pauseClockAt(events.at(-1)!.ts)
    return { ok: true, events: events.length, backup }
  }

  /** Undoes the character's most recent value, base, stat, trait or item change still in effect. */
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
        e.type === 'item_added' ||
        e.type === 'item_removed' || // a mis-tapped Discard comes back
        e.type === 'item_enabled_set' ||
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

  /**
   * Starts a new challenge, becoming the current one (any previous one falls into history).
   * One difficulty covers the whole thing. The resolution ability is what decides it; the
   * **framing ability is optional** (user decision) — skip it and the resolution check is the
   * whole challenge. The name is optional too: a quick challenge needs none.
   */
  startChallenge(
    opts: {
      description?: string
      framingAbility?: string | null
      resolutionAbility: string
      difficulty: number
      stakes: ChallengeStakes
    },
    by: string,
  ) {
    const framingAbility = opts.framingAbility || null
    if (framingAbility !== null && !this.isAbilityField(framingAbility)) return null
    if (!this.isAbilityField(opts.resolutionAbility)) return null
    if (!Number.isFinite(opts.difficulty)) return null
    return this.append({
      type: 'challenge_started',
      challengeId: crypto.randomUUID().slice(0, 8),
      description: (opts.description ?? '').trim().slice(0, 200),
      framingAbility,
      resolutionAbility: opts.resolutionAbility,
      difficulty: Math.round(opts.difficulty),
      stakes: opts.stakes,
      by,
    })
  }

  /**
   * Sets who's rolling and their approach/skill. Any of the three may be cleared with null.
   * All of it is declared before the dice and locked once they land — see below.
   */
  setChallengePlayer(challengeId: string, charId: string | null, approach: string | null, skill: string | null, by: string) {
    const ch = this.challengeById(challengeId)
    if (!ch || ch.closed) return null
    // Everything here is declared before the dice: the approach die is rolled with them, the
    // skill is a bonus on results that are already on the table, and the player is the one who
    // rolled. None of it moves once the roll is in.
    if (this.hasRolled(ch)) return null
    // In a group task the participant is fixed and there is no approach: only the skill is theirs.
    if (ch.groupId && (charId !== ch.charId || approach !== null)) return null
    if (charId !== null && !this.characters.has(charId)) return null
    if (approach !== null && !this.rules.challenges.approaches.some((a) => a.id === approach)) return null
    if (skill !== null) {
      const f = this.rules.fields.get(skill)
      if (!f || f.type !== 'number' || !f.trained) return null
      const roller = charId ? this.characters.get(charId) : undefined
      if (roller && !this.fieldVisible(roller, f.id)) return null // a hidden (e.g. magical) skill
    }
    return this.append({ type: 'challenge_player_set', challengeId, charId, approach, skill, by })
  }

  /** Where a challenge has got to: picking, rolled, closed. */
  challengePhase(ch: Challenge): 'setup' | 'rolled' | 'done' {
    if (ch.closed) return 'done'
    return this.hasRolled(ch) ? 'rolled' : 'setup'
  }

  /** Any dice in: both rolls of a challenge land together, but an attack's hit comes first alone. */
  hasRolled(ch: Challenge) {
    return !!(ch.framing || ch.resolution)
  }

  /**
   * An attack's step (user decision: sequential): `hit` once the hit is rolled and can still be
   * altered, `damage` once the damage is rolled (the hit is then locked). Null before the roll
   * and for anything but an attack.
   */
  attackStep(ch: Challenge): 'hit' | 'damage' | null {
    if (!ch.attack || !ch.framing) return null
    return ch.resolution ? 'damage' : 'hit'
  }

  /** Two-step challenges (attacks, magic): the first roll alone, the second once it is settled. */
  isSequential(ch: Challenge) {
    return !!(ch.attack || ch.magic)
  }

  /** A magic roll's step: `magnitude` once rolled (still open), `control` once control is rolled. */
  magicStep(ch: Challenge): 'magnitude' | 'control' | null {
    if (!ch.magic || !ch.framing) return null
    return ch.resolution ? 'control' : 'magnitude'
  }

  /** The rolling player's current rank in one of the challenge's abilities. */
  private challengeRank(ch: Challenge, roll: ChallengeRoll) {
    // An NPC caster's ranks are the GM's numbers.
    const npc = ch.magic?.npc
    if (npc) return roll === 'framing' ? npc.magnitudeRank : npc.controlRank
    const char = ch.charId ? this.characters.get(ch.charId) : null
    const abilityId = roll === 'framing' ? ch.framingAbility : ch.resolutionAbility
    const field = abilityId ? this.rules.fields.get(abilityId) : undefined
    return char && field && field.type === 'number' ? Number(this.valueOf(char, field)) : null
  }

  /**
   * Rolls the challenge: the framing check (when there is one) and the resolution check **at the
   * same time**, in one event, so the table sees both results together (user decision). Nothing
   * the framing does to the resolution touches its dice — the ladder is arithmetic, worked out
   * live in challengeMath() — so a later exertion on the framing still moves its bonus.
   * The approach die is a plain d6, no rank shift. Once per challenge.
   */
  rollChallenge(challengeId: string, by: string) {
    const ch = this.challengeById(challengeId)
    if (!ch || ch.closed || (!ch.charId && !ch.magic?.npc) || this.hasRolled(ch)) return null
    if (this.isSequential(ch)) {
      // An attack rolls the hit first, alone — a magic roll its magnitude — with the approach die,
      // whose effect the player may cash in during either step (user decision). The second roll
      // is rollDamage() / rollMagicControl().
      const hitRank = this.challengeRank(ch, 'framing')
      if (hitRank === null) return null
      return this.append({
        type: 'challenge_rolled',
        challengeId,
        framing: rollChallengeSide(hitRank),
        approachDie: ch.approach && ch.charId ? cryptoRng(APPROACH_DIE_SIDES) : undefined,
        by,
      })
    }
    const resolutionRank = this.challengeRank(ch, 'resolution')
    if (resolutionRank === null) return null
    const framingRank = ch.framingAbility ? this.challengeRank(ch, 'framing') : null
    if (ch.framingAbility && framingRank === null) return null
    return this.append({
      type: 'challenge_rolled',
      challengeId,
      framing: framingRank === null ? undefined : rollChallengeSide(framingRank),
      resolution: rollChallengeSide(resolutionRank),
      approachDie: ch.approach ? cryptoRng(APPROACH_DIE_SIDES) : undefined,
      by,
    })
  }

  /**
   * A magic roll's second step: the caster activates `activated` of the magnitude's successes
   * (1 … all of them) and rolls control against 3 per success — which locks the magnitude. The
   * player casting (their charId), or the GM (null) for an NPC. Not while an approach effect waits
   * for its taps, and not with no success to activate.
   */
  rollMagicControl(challengeId: string, charId: string | null, activated: number, by: string) {
    const ch = charId === null ? this.challengeById(challengeId) : this.actingCharacter(challengeId, charId)?.ch
    if (!ch?.magic || ch.closed || this.magicStep(ch) !== 'magnitude' || ch.approachPicksLeft > 0) return null
    if (charId === null && !ch.magic.npc) return null // a player's cast is theirs to roll
    const successes = this.challengeMath(ch).magic?.successes ?? 0
    if (!Number.isInteger(activated) || activated < 1 || activated > successes) return null
    const rank = this.challengeRank(ch, 'resolution')
    if (rank === null) return null
    return this.append({ type: 'magic_control_rolled', challengeId, activated, resolution: rollChallengeSide(rank), by })
  }

  /**
   * An attack's second step: the player is done with the hit and rolls the damage — which locks
   * the hit (no more exertion, rerolls, hand edits or approach taps on it). Not on a miss (there
   * is no damage to roll), and not while an approach effect is still waiting for its taps.
   */
  rollDamage(challengeId: string, charId: string, by: string) {
    const acting = this.actingCharacter(challengeId, charId)
    const ch = acting?.ch
    if (!ch?.attack || this.attackStep(ch) !== 'hit' || ch.approachPicksLeft > 0) return null
    if (this.challengeMath(ch).attack?.tier?.miss) return null
    const rank = this.challengeRank(ch, 'resolution')
    if (rank === null) return null
    return this.append({
      type: 'attack_damage_rolled',
      challengeId,
      resolution: rollChallengeSide(rank),
      critDie: rollOneFace(rank),
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
   * - `failure` (Unbreakable): only if the framing **or** the resolution was short of its target
   *   **the instant the dice landed** (`failingAtRoll`) — decided once, not live off the sums.
   *   Exertion, a reroll or a later circumstance nudge can turn that failure into a success
   *   afterwards without taking the option away; once activated the die also stays `active`
   *   regardless, so an effect that itself turns the roll into a success (raising dice, say)
   *   doesn't grey out the very thing that caused it.
   * - `choice` (Exquisite): whenever the player likes.
   *
   * `effect` is what this face does (null when the approach has none configured), `canActivate`
   * says whether the button belongs on screen, and `picksLeft` counts the dice an activated
   * effect is still waiting to be tapped.
   * Returns null until the resolution is rolled (the approach die lands with it), and for a
   * challenge with no approach at all.
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
          : ch.failingAtRoll
            ? 'active'
            : 'skipped'
    const effect = approachEffect(approach, ch.approachDie)
    // With effects configured the button applies one, so a blank face offers nothing. Without
    // them (Exquisite — effects still to come) only `choice` has a button at all.
    // Setup lowers a die and Perfect choice maxes one, so with every die already at that end there
    // is nothing to do and it can't be activated (user decision).
    const needsMovableDie = effect?.kind === 'lower_face' || effect?.kind === 'max_face'
    const worthActivating = approach.effects.length
      ? effectCanActivate(effect) && (!needsMovableDie || ch.approachActivated || this.anyTweakableDie(ch))
      : approach.when === 'choice'
    return {
      approach,
      die: ch.approachDie,
      status,
      effect,
      canActivate: worthActivating && !ch.approachActivated && status !== 'skipped',
      pending: ch.approachPicksLeft > 0,
      picksLeft: ch.approachPicksLeft,
      step: effectStep(effect, ch.approachPicksLeft),
    }
  }

  /**
   * Presses Activate on the approach die. Effects that need a die tapped (discard, reroll, a
   * face change) leave that many `approachPicksLeft`, and those taps may land on either roll.
   * `extra_dice` waits for the player to pick **one** roll for its dice (addApproachDice) — or,
   * with framing skipped, goes straight onto the resolution. `match_highest` is done here and
   * now on **both** rolls (the framing one only when there is one).
   * One way only, and never after the GM closes the challenge.
   */
  activateApproach(challengeId: string, charId: string, by: string) {
    const acting = this.actingCharacter(challengeId, charId)
    if (!acting) return false
    const state = this.approachState(acting.ch)
    if (!state?.canActivate) return false
    this.append({ type: 'challenge_approach_activated', challengeId, by })
    const open = this.rollsInPlay(acting.ch)
    if (state.effect?.kind === 'extra_dice' && open.length === 1) this.applyExtraDice(acting.ch, open[0]!, state.effect, by)
    if (state.effect?.kind === 'match_highest') {
      for (const roll of this.rollsInPlay(acting.ch)) this.applyMatchHighest(acting.ch, roll, by)
    }
    return true
  }

  /**
   * GM debug tool: forces the approach die onto `die` so a face's effect can be tried without
   * rolling for it. Only while the resolution is rolled, the challenge has an approach and it is
   * still open. Activate is re-armed (as if the die had just landed on that face), but changes an
   * earlier activation already made to the dice — discards, rerolls, moved faces —
   * stay: they are rolled results, and the log keeps both events.
   */
  setApproachDie(challengeId: string, die: number, by: string) {
    const ch = this.challengeById(challengeId)
    if (!ch || ch.closed || !this.hasRolled(ch) || !ch.approach) return false
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
   * A die that is on the board and still counting. A roll is not a fixed pair — the framing
   * ladder and `extra_dice`/`discard_double` grow it — so the index is checked against what that
   * roll actually holds now.
   */
  private dieInPlay(ch: Challenge, roll: ChallengeRoll, index: number) {
    if (!this.rollsInPlay(ch).includes(roll)) return null // an attack's locked (or unrolled) roll
    const rolled = ch[roll]
    if (!rolled || !Number.isInteger(index) || index < 0 || index >= rolled.dice.length) return null
    return rolled.discarded?.[index] ? null : rolled // discarded dice are out of play
  }

  /**
   * The rolls that can still be acted on — exertion, rerolls, hand edits, approach taps, support:
   * framing (when there is one) and resolution. An attack has one at a time: the hit until the
   * damage is rolled, then only the damage (user decision: the hit is locked by then).
   */
  rollsInPlay(ch: Challenge): ChallengeRoll[] {
    if (this.isSequential(ch)) return ch.resolution ? ['resolution'] : ch.framing ? ['framing'] : []
    return ch.framing ? ['framing', 'resolution'] : ['resolution']
  }

  /** A die the effect may still be pointed at: in play, and not already picked. */
  private pickableDie(ch: Challenge, roll: ChallengeRoll, index: number) {
    const rolled = this.dieInPlay(ch, roll, index)
    if (!rolled) return null
    return ch.approachPicked.includes(`${roll}:${index}`) ? null : rolled // one pick per die
  }

  /**
   * Whether Tweak (`lower_raise`) or Setup (`lower_face`) may be pointed at this die right now. On top of being pickable,
   * the die must have somewhere to go: **a die on the worst face cannot be lowered and one on the
   * best face cannot be raised** (user decision), because that tap would spend the pick and move
   * nothing. The board asks this before making a die a button, so those dice are never offered.
   *
   * Setup always lowers, so it is the "first step" rule throughout (effectStep is 'first' for a
   * single-pick kind). `raise_face` (Unbreakable) doesn't work this way — it still spends its pick
   * on a top-face die by an earlier decision, and its prompt counts those taps down.
   */
  tweakableDie(ch: Challenge, index: number, roll: ChallengeRoll = 'resolution') {
    if (!this.pickableDie(ch, roll, index)) return false
    const face = ch[roll]?.faces?.[index]
    if (face === undefined) return false
    const { faces } = this.rules.challenges
    if (faces.length === 0) return true // no faces configured, so nothing to be at the end of
    return this.lowersNow(ch) ? face > faces[0]!.value : face < faces.at(-1)!.value
  }

  /**
   * Whether the effect's next tap moves a die **down** (Setup, Tweak's first step) rather than up
   * (Tweak's second step, Perfect choice's `max_face`) — which end a die must be off to be offered.
   */
  private lowersNow(ch: Challenge) {
    const kind = this.approachEffectOf(ch)?.kind
    return kind === 'lower_face' || (kind === 'lower_raise' && this.stepOf(ch) === 'first')
  }

  /** Whether any die on the board — either roll — is still a legal target for Tweak's current step. */
  anyTweakableDie(ch: Challenge) {
    return this.rollsInPlay(ch).some((roll) =>
      (ch[roll]?.dice ?? []).some((_, index) => this.tweakableDie(ch, index, roll)),
    )
  }

  /**
   * Approach effect: the tapped die stops counting (it stays on screen, struck through).
   * Also the **first** step of `discard_double`, whose second step copies another die.
   */
  discardDie(challengeId: string, charId: string, index: number, by: string, roll: ChallengeRoll = 'resolution') {
    const pending = this.pendingEffect(challengeId, charId, ['discard', 'discard_double'])
    if (!pending || !this.pickableDie(pending.ch, roll, index)) return false
    // discard_double discards on its first pick only; the second one is the copy.
    if (pending.effect.kind === 'discard_double' && this.stepOf(pending.ch) !== 'first') return false
    this.append({ type: 'challenge_die_discarded', challengeId, roll, index, by })
    return true
  }

  /** Which step of a two-step approach effect this challenge is waiting on. */
  private stepOf(ch: Challenge) {
    return effectStep(this.approachEffectOf(ch), ch.approachPicksLeft)
  }

  /** Approach effect: the tapped die is rolled again, free of exertion. */
  approachReroll(challengeId: string, charId: string, index: number, by: string, roll: ChallengeRoll = 'resolution') {
    const pending = this.pendingEffect(challengeId, charId, ['reroll'])
    if (!pending || !this.pickableDie(pending.ch, roll, index)) return false
    const rank = this.challengeRank(pending.ch, roll)
    if (rank === null) return false
    const { face, value } = rollOneFace(rank)
    this.append({ type: 'challenge_rerolled', challengeId, roll, index, face, value, source: 'approach', by })
    return true
  }

  /**
   * Approach effect: the tapped die's face moves — one step up (`raise_face`) or onto a fixed
   * face (`set_face`). The rank shift is taken from the die itself, so the new value stays in
   * step with how that die was rolled. A raise that can't go higher still spends the pick, and
   * the die then carries no marker because nothing moved.
   */
  changeDieFace(challengeId: string, charId: string, index: number, by: string, roll: ChallengeRoll = 'resolution') {
    const pending = this.pendingEffect(challengeId, charId, ['raise_face', 'set_face', 'lower_raise', 'lower_face', 'max_face'])
    const rolled = pending && this.pickableDie(pending.ch, roll, index)
    if (!pending || !rolled?.faces) return false
    const was = rolled.faces[index]!
    const { kind } = pending.effect
    // Tweak (`lower_raise`) lowers on its first pick and raises on its second, and refuses a die
    // that is already at the end it would move toward (see tweakableDie).
    // Setup (`lower_face`) only ever lowers, and Perfect choice (`max_face`) only ever maxes,
    // under the same rule.
    const onlyMovable = kind === 'lower_raise' || kind === 'lower_face' || kind === 'max_face'
    if (onlyMovable && !this.tweakableDie(pending.ch, index, roll)) return false
    const lowering = this.lowersNow(pending.ch)
    const face = lowering
      ? Math.max(this.bottomFace(was), was - 1)
      : kind === 'set_face'
        ? pending.effect.toFace
        : kind === 'max_face'
          ? this.topFace(6)
          : Math.min(this.topFace(was), was + 1)
    const shift = rolled.dice[index]! - was
    const moved: DieMarker = lowering
      ? 'lowered'
      : kind === 'set_face'
        ? 'squashed'
        : kind === 'max_face'
          ? 'maxed'
          : 'raised'
    const marker: DieMarker = face === was ? null : moved
    this.append({
      type: 'challenge_face_changed',
      challengeId,
      roll,
      index,
      face,
      value: face + shift,
      marker,
      by,
    })
    return true
  }

  /** Best/worst configured face ids; `fallback` covers rules with no faces listed at all. */
  private topFace = (fallback: number) => this.rules.challenges.faces.at(-1)?.value ?? fallback
  private bottomFace = (fallback: number) => this.rules.challenges.faces[0]?.value ?? fallback

  /**
   * Approach effect `match_highest` (Perfect balance): one roll's **lowest** die rises to the
   * face of its **highest**. Discarded dice are out of it on both counts. Activate runs it on
   * each roll in turn, each against its own dice; a roll whose dice already match moves
   * nothing, and one with nothing in play does nothing at all.
   */
  private applyMatchHighest(ch: Challenge, roll: ChallengeRoll, by: string) {
    const rolled = ch[roll]
    if (!rolled?.faces) return
    const inPlay = rolled.faces.flatMap((face, i) => (rolled.discarded?.[i] ? [] : [{ face, i }]))
    if (inPlay.length === 0) return
    const lowest = inPlay.reduce((low, d) => (d.face < low.face ? d : low))
    const highest = inPlay.reduce((high, d) => (d.face > high.face ? d : high))
    if (highest.face === lowest.face) return // nothing to rise to
    const shift = rolled.dice[lowest.i]! - lowest.face
    this.append({
      type: 'challenge_face_changed',
      challengeId: ch.id,
      roll,
      index: lowest.i,
      face: highest.face,
      value: highest.face + shift,
      marker: 'matched',
      by,
    })
  }

  /**
   * Second step of `discard_double` (Perfect choice): a twin of the tapped die joins **that
   * die's own roll** and counts. The one-pick-per-die rule keeps it off the die just discarded.
   */
  duplicateDie(challengeId: string, charId: string, index: number, by: string, roll: ChallengeRoll = 'resolution') {
    const pending = this.pendingEffect(challengeId, charId, ['discard_double'])
    const rolled = pending && this.pickableDie(pending.ch, roll, index)
    if (!pending || !rolled?.faces) return false
    if (this.stepOf(pending.ch) !== 'second') return false // the discard comes first
    this.append({
      type: 'challenge_dice_added',
      challengeId,
      roll,
      faces: [rolled.faces[index]!],
      values: [rolled.dice[index]!],
      markers: ['copied'],
      from: index,
      by,
    })
    return true
  }

  /** Approach effect `extra_dice`, once activated: the player picks the roll its dice join. */
  addApproachDice(challengeId: string, charId: string, roll: ChallengeRoll, by: string) {
    const pending = this.pendingEffect(challengeId, charId, ['extra_dice'])
    if (!pending || !pending.ch[roll] || !this.rollsInPlay(pending.ch).includes(roll)) return false
    this.applyExtraDice(pending.ch, roll, pending.effect, by)
    return true
  }

  /** Approach effect `extra_dice`: more dice for one roll, at that roll's ability rank. */
  private applyExtraDice(ch: Challenge, roll: ChallengeRoll, effect: ApproachEffect, by: string) {
    const rank = this.challengeRank(ch, roll)
    if (rank === null || !ch[roll]) return
    const rolls = Array.from({ length: effect.dice }, () => rollOneFace(rank))
    this.append({
      type: 'challenge_dice_added',
      challengeId: ch.id,
      roll,
      faces: rolls.map((r) => r.face),
      values: rolls.map((r) => r.value),
      by,
    })
  }

  /**
   * The declared skill's rank, which is added to **each rolled result** — one point per rank.
   * 0 when no skill is declared (or the character/field has since gone).
   */
  challengeSkillBonus(ch: Challenge) {
    const char = ch.charId ? this.characters.get(ch.charId) : null
    const field = ch.skill ? (this.rules.fields.get(ch.skill) as NumberField | undefined) : undefined
    if (!char || !field) return { bonus: 0, label: null as string | null, icon: null as Icon | null }
    return {
      // The trained rank plus what enabled equipment adds to that skill (a temporary ✎ change
      // stays out, as before).
      bonus: Math.max(0, Math.round(Number(this.baseOf(char, field))) + this.itemBonus(char, field.id)),
      label: field.label,
      icon: field.icon ?? null,
    }
  }

  /**
   * Everything the challenge's numbers add up to — the only place that arithmetic lives, so
   * every screen, the approach's `failure` rule and the history log agree. Works at any phase:
   * before the roll it is just the target, and `success` stays null until the dice are in.
   *
   * It is **derived, never stored**, which is what makes the framing recalculate on the fly: a
   * point of exertion or a reroll on the framing changes its margin, which changes the rung,
   * which moves the resolution's target and its degrees — all on the next render.
   */
  challengeMath(ch: Challenge): ChallengeMath {
    if (ch.attack) return this.attackMath(ch, ch.attack)
    if (ch.magic) return this.magicMath(ch, ch.magic)
    const { bonus, label, icon } = this.challengeSkillBonus(ch)
    // The skill is a bonus on the roll (user decision), so it never moves the difficulty.
    const target = ch.difficulty + ch.circumstance
    const framing = ch.framing
      ? outcomeFor(ch.framing.sum + bonus + ch.exertionFraming + ch.customFraming + this.supportTotal(ch, 'framing'), target, 'low')
      : null
    const rung = framing ? framingRung(this.rules.challenges.framing, framing.difference) : null
    // The rung buffs the resolution roll's own sum (user decision — it used to move the target).
    const rungBonus = rung?.resolutionBonus ?? 0
    const resolution = ch.resolution
      ? outcomeFor(
          ch.resolution.sum + bonus + ch.exertionResolution + ch.customResolution + this.supportTotal(ch, 'resolution') + rungBonus,
          target,
          ch.stakes,
        )
      : null
    const nextRung = framing ? this.rules.challenges.framing.rungs.find((r) => r.from > framing.difference) : undefined
    const framingPointsToNext = framing && nextRung ? nextRung.from - framing.difference : null
    const resolutionPointsToNext = resolution ? pointsToImprove(resolution.difference, ch.stakes) : null
    return {
      difficulty: ch.difficulty,
      circumstance: ch.circumstance,
      skillBonus: bonus,
      skillLabel: label,
      skillIcon: icon,
      target,
      framing,
      rung,
      rungBonus,
      framingPointsToNext,
      resolution,
      // The rung's boon/complication is added to whatever the stakes produced (user decision).
      degrees: (resolution?.degrees ?? 0) + (rung?.degrees ?? 0),
      resolutionPointsToNext,
      success: resolution ? resolution.success : null,
    }
  }

  /**
   * An attack's numbers (see Attack): the hit against the enemy's defence, the hit tier it lands
   * on, and the damage roll — with the tier's effect on it — against the other defence. Live, like
   * any challenge: exertion on the hit can lift a glancing blow to a normal hit and the discarded
   * die counts again. `success` is "it wounded".
   */
  private attackMath(ch: Challenge, a: Attack): ChallengeMath {
    const { bonus, label, icon } = this.challengeSkillBonus(ch)
    const char = ch.charId ? this.characters.get(ch.charId) : undefined
    const accuracy = char ? this.itemBonus(char, ACCURACY_STAT) : 0
    const weapon = char ? this.itemBonus(char, DAMAGE_STAT) : 0
    const hitTarget = hitTargetOf(a.hitVs, a.hitValue, a.evasionSpent) + ch.circumstance
    const damageTarget = a.damageValue + ch.circumstance
    const framing = ch.framing
      ? outcomeFor(
          ch.framing.sum + bonus + accuracy + ch.exertionFraming + ch.customFraming + this.supportTotal(ch, 'framing'),
          hitTarget,
          'low',
        )
      : null
    const tier = framing ? hitTier(framing.difference) : null
    const dropped = tier?.drop && ch.resolution ? glancingDrop(ch.resolution) : null
    const droppedValue = dropped === null ? 0 : ch.resolution!.dice[dropped]!
    const critValue = tier?.extraDie ? (a.critDie?.value ?? 0) : null
    const resolution =
      ch.resolution && tier && !tier.miss
        ? outcomeFor(
            ch.resolution.sum -
              droppedValue +
              (critValue ?? 0) +
              bonus +
              weapon +
              tier.damageBonus +
              ch.exertionResolution +
              ch.customResolution +
              this.supportTotal(ch, 'resolution'),
            damageTarget,
            'low',
          )
        : null
    const wounds = resolution ? woundsFor(resolution.difference) : 0
    return {
      difficulty: hitTarget - ch.circumstance,
      circumstance: ch.circumstance,
      skillBonus: bonus,
      skillLabel: label,
      skillIcon: icon,
      target: hitTarget,
      framing,
      rung: null,
      rungBonus: tier?.damageBonus ?? 0,
      framingPointsToNext: framing ? pointsToNextTier(framing.difference) : null,
      resolution,
      degrees: 0,
      resolutionPointsToNext: resolution ? pointsToNextWound(resolution.difference) : null,
      success: framing && ch.resolution ? wounds > 0 : null,
      attack: { hitTarget, damageTarget, accuracy, weapon, tier, dropped, critValue, wounds },
    }
  }

  /**
   * A magic roll's numbers (see Magic): the magnitude against 0 and its successes, and — once some
   * are activated — the control roll against 3 each. Circumstance moves both targets. `success`
   * is the control roll's (null until it's rolled).
   */
  private magicMath(ch: Challenge, m: Magic): ChallengeMath {
    const { bonus, label, icon } = this.challengeSkillBonus(ch)
    const magnitudeTarget = ch.circumstance
    const framing = ch.framing
      ? outcomeFor(ch.framing.sum + bonus + ch.exertionFraming + ch.customFraming + this.supportTotal(ch, 'framing'), magnitudeTarget, 'low')
      : null
    const successes = framing ? Math.max(0, Math.floor(framing.difference / MAGIC_STEP)) : null
    // The magnitude "succeeds" when it gives at least one success (what Unbreakable reads).
    if (framing) framing.success = (successes ?? 0) > 0
    const controlTarget = m.activated !== null ? m.activated * MAGIC_STEP + ch.circumstance : null
    const resolution =
      ch.resolution && controlTarget !== null
        ? outcomeFor(
            ch.resolution.sum + bonus + ch.exertionResolution + ch.customResolution + this.supportTotal(ch, 'resolution'),
            controlTarget,
            'low',
          )
        : null
    const pointsToNextSuccess = framing ? MAGIC_STEP - (Math.max(0, framing.difference) % MAGIC_STEP) + (framing.difference < 0 ? -framing.difference : 0) : null
    return {
      difficulty: 0,
      circumstance: ch.circumstance,
      skillBonus: bonus,
      skillLabel: label,
      skillIcon: icon,
      target: magnitudeTarget,
      framing,
      rung: null,
      rungBonus: 0,
      framingPointsToNext: pointsToNextSuccess,
      resolution,
      degrees: 0,
      resolutionPointsToNext: resolution && !resolution.success ? -resolution.difference : null,
      success: resolution ? resolution.success : null,
      magic: { successes, pointsToNextSuccess, activated: m.activated, controlTarget },
    }
  }

  /**
   * The GM starts a magic roll: the caster is a finished character (who then picks a skill and an
   * approach and rolls, as in any challenge) or an NPC with the GM's two ranks; the magnitude and
   * control abilities are the GM's pick. It becomes the current challenge.
   */
  startMagic(
    opts: {
      charId?: string | null
      npc?: { name: string; magnitudeRank: number; controlRank: number } | null
      magnitudeAbility: string
      controlAbility: string
      description?: string
    },
    by: string,
  ) {
    if (!this.isAbilityField(opts.magnitudeAbility) || !this.isAbilityField(opts.controlAbility)) return null
    const char = opts.charId ? this.characters.get(opts.charId) : undefined
    let npc: Magic['npc'] = null
    if (!char) {
      const n = opts.npc
      if (!n || !Number.isFinite(n.magnitudeRank) || !Number.isFinite(n.controlRank)) return null
      npc = {
        name: cleanName(n.name) || 'NPC',
        magnitudeRank: Math.max(-9, Math.min(15, Math.round(n.magnitudeRank))),
        controlRank: Math.max(-9, Math.min(15, Math.round(n.controlRank))),
      }
    } else if (char.status !== 'active') return null
    const challengeId = crypto.randomUUID().slice(0, 8)
    const started = this.append({
      type: 'challenge_started',
      challengeId,
      description: (opts.description ?? '').trim().slice(0, 200),
      framingAbility: opts.magnitudeAbility,
      resolutionAbility: opts.controlAbility,
      difficulty: 0,
      stakes: 'low',
      magic: { npc },
      by,
    })
    if (!char) return started
    return this.append({ type: 'challenge_player_set', challengeId, charId: char.id, approach: null, skill: null, by })
  }

  // ---- combat ----------------------------------------------------------------
  /**
   * The GM sets up a player's attack on an enemy: it becomes the current challenge, already
   * handed to that player (who then picks a skill/approach and rolls, as in any challenge). The
   * hit roll uses `hitAbility` against the enemy's `hitVs` defence (Evasion by default — 0 if it
   * has been attacked this round, unless the GM says otherwise), the damage roll `damageAbility`
   * against `damageVs` (Physical resistance), and the wounds come off `pool` (Health).
   */
  startAttack(
    opts: {
      enemyId: string
      charId: string
      hitAbility: string
      damageAbility: string
      hitVs?: string
      damageVs?: string
      pool?: string
      evasionSpent?: boolean
      description?: string
    },
    by: string,
  ) {
    const en = this.bestiary.enemy(opts.enemyId)
    const char = this.characters.get(opts.charId)
    if (!en || char?.status !== 'active') return null
    if (!this.isAbilityField(opts.hitAbility) || !this.isAbilityField(opts.damageAbility)) return null
    const hitVs: Defence = isDefence(opts.hitVs) ? opts.hitVs : 'evasion'
    const damageVs: Defence = isDefence(opts.damageVs) ? opts.damageVs : 'physical'
    const pool: WoundPool = isWoundPool(opts.pool) ? opts.pool : 'health'
    const evasionSpent = opts.evasionSpent ?? this.bestiary.evasionSpent('enemy', en.id)
    const hitValue = en.stats[defence(hitVs).enemyKey]
    const challengeId = crypto.randomUUID().slice(0, 8)
    this.append({
      type: 'challenge_started',
      challengeId,
      description: (opts.description ?? '').trim().slice(0, 200),
      framingAbility: opts.hitAbility,
      resolutionAbility: opts.damageAbility,
      difficulty: hitTargetOf(hitVs, hitValue, evasionSpent),
      stakes: 'low',
      attack: {
        enemyId: en.id,
        enemyName: en.name,
        hitVs,
        damageVs,
        pool,
        hitValue,
        damageValue: en.stats[defence(damageVs).enemyKey],
        evasionSpent,
      },
      by,
    })
    return this.append({ type: 'challenge_player_set', challengeId, charId: char.id, approach: null, skill: null, by })
  }

  /**
   * An enemy attacks a player — rolled and settled at once (no active defence yet): see
   * EnemyAttack. The player's defences are their sheet's current values (items included); their
   * Evasion is 0 if something already attacked them this round. The wounds come off the pool
   * straight away (a sheet pool stops at 0).
   */
  enemyAttack(enemyId: string, charId: string, opts: { hitVs?: string; damageVs?: string; pool?: string }, by: string) {
    const en = this.bestiary.enemy(enemyId)
    const char = this.characters.get(charId)
    if (!en || char?.status !== 'active') return null
    const hitVs: Defence = isDefence(opts.hitVs) ? opts.hitVs : 'evasion'
    const damageVs: Defence = isDefence(opts.damageVs) ? opts.damageVs : 'physical'
    const pool: WoundPool = isWoundPool(opts.pool) ? opts.pool : 'health'
    const hitStat = this.statOf(char, defence(hitVs).charStat)
    const damageStat = this.statOf(char, defence(damageVs).charStat)
    const poolStat = this.statOf(char, pool)
    if (!hitStat || !damageStat || !poolStat) return null
    const evasionSpent = this.bestiary.evasionSpent('char', char.id)
    const s = en.stats
    const hit = rollDiceSide(s.hitDice, s.hitRank)
    const hitTarget = hitTargetOf(hitVs, hitStat.current, evasionSpent)
    const tier = hitTier(hit.sum + s.hitBonus - hitTarget)
    let damage: ChallengeSide | null = null
    if (!tier.miss) {
      damage = rollDiceSide(s.damageDice, s.damageRank)
      const drop = tier.drop ? glancingDrop(damage, s.damageDice) : null
      if (drop !== null) damage.discarded = damage.dice.map((_, i) => i === drop)
    }
    const critDie = tier.extraDie ? rollOneFace(s.damageRank) : null
    const numbers = {
      hit,
      hitBonus: s.hitBonus,
      hitTarget,
      damage,
      critDie,
      damageBonus: s.damageBonus,
      damageTarget: damageStat.current,
    }
    const { wounds } = enemyAttackMath(numbers)
    const to = Math.max(0, poolStat.current - wounds)
    return this.append({
      type: 'enemy_attacked',
      attackId: crypto.randomUUID().slice(0, 8),
      enemyId: en.id,
      enemyName: en.name,
      charId: char.id,
      charName: char.name,
      hitVs,
      damageVs,
      pool,
      evasionSpent,
      ...numbers,
      wounds,
      from: poolStat.current,
      to,
      adj: to - poolStat.normal,
      by,
    })
  }

  /** The GM adds a line of their own to the table's history log. Blank text adds nothing. */
  addLogNote(text: string, by: string) {
    const clean = text.replace(/\s+/g, ' ').trim().slice(0, 300)
    if (!clean) return null
    return this.append({ type: 'log_note_added', noteId: crypto.randomUUID().slice(0, 8), text: clean, by })
  }

  nextCombatRound(by: string) {
    return this.logEnemy(this.bestiary.planNextRound(by))
  }

  // ---- challenges by id ----------------------------------------------------
  /** A challenge by id: a regular one, or one participant's part of a group task. */
  challengeById(id: string): Challenge | undefined {
    return this.challenges.find((x) => x.id === id) ?? this.groupTasks.flatMap((g) => g.members).find((x) => x.id === id)
  }

  /** A fresh, unrolled challenge — for `challenge_started` and each group task participant. */
  private newChallenge(c: {
    id: string
    seq: number
    description: string
    framingAbility: string | null
    resolutionAbility: string
    difficulty: number
    stakes: ChallengeStakes
    by: string
  }): Challenge {
    return {
      ...c,
      circumstance: 0,
      charId: null,
      approach: null,
      approachDie: null,
      approachActivated: false,
      approachPicksLeft: 0,
      approachPicked: [],
      skill: null,
      exertionGained: 0,
      exertionFraming: 0,
      exertionResolution: 0,
      rerolls: 0,
      exertionRerollArmed: false,
      customFraming: 0,
      customResolution: 0,
      supporters: [],
      groupId: null,
      attack: null,
      magic: null,
      closed: false,
      framing: null,
      resolution: null,
      failingAtRoll: null,
    }
  }

  // ---- group tasks ----------------------------------------------------------
  /** The group task on the board, if any — always the most recently started. */
  currentGroupTask(): GroupTask | null {
    return this.groupTasks.at(-1) ?? null
  }

  /** This character's part of the current group task, while it is still open. */
  groupMemberOf(charId: string): Challenge | null {
    const g = this.currentGroupTask()
    if (!g || g.closed) return null
    return g.members.find((m) => m.charId === charId) ?? null
  }

  /**
   * The GM starts a group task: an optional description, the one difficulty (already nudged in
   * the dialog), stakes, an optional framing and a resolution ability, and **who takes part** —
   * one or more different finished characters.
   */
  startGroupTask(
    opts: {
      description?: string
      framingAbility?: string | null
      resolutionAbility: string
      difficulty: number
      stakes: ChallengeStakes
      charIds: string[]
    },
    by: string,
  ) {
    const framingAbility = opts.framingAbility || null
    if (framingAbility !== null && !this.isAbilityField(framingAbility)) return null
    if (!this.isAbilityField(opts.resolutionAbility) || !Number.isFinite(opts.difficulty)) return null
    const charIds = [...new Set(opts.charIds)]
    if (charIds.length === 0 || charIds.some((id) => this.characters.get(id)?.status !== 'active')) return null
    return this.append({
      type: 'group_task_started',
      groupId: crypto.randomUUID().slice(0, 8),
      description: (opts.description ?? '').trim().slice(0, 200),
      difficulty: Math.round(opts.difficulty),
      stakes: opts.stakes,
      framingAbility,
      resolutionAbility: opts.resolutionAbility,
      members: charIds.map((charId) => ({ challengeId: crypto.randomUUID().slice(0, 8), charId })),
      by,
    })
  }

  /** "Complete group challenge": closes every participant's part at once, rolled or not. */
  closeGroupTask(groupId: string, by: string) {
    const g = this.groupTasks.find((x) => x.id === groupId)
    if (!g || g.closed) return false
    this.append({ type: 'group_task_closed', groupId, by })
    return true
  }

  /**
   * The summary under a group task: every rolled participant's resolution margin (after their
   * framing rung, skill and exertion — challengeMath), added up. `rolled` of `total` have rolled.
   */
  groupTotal(g: GroupTask) {
    const results = g.members.flatMap((m) => {
      const r = this.challengeMath(m).resolution
      return r ? [r.difference] : []
    })
    return { sum: results.reduce((a, b) => a + b, 0), rolled: results.length, total: g.members.length }
  }

  // ---- support ----------------------------------------------------------------
  /** What the supporters' dice add to one of the challenge's checks. */
  supportTotal(ch: Challenge, roll: ChallengeRoll) {
    return ch.supporters.reduce((sum, sp) => (sp.roll === roll && sp.die ? sum + sp.die.value : sum), 0)
  }

  /**
   * The GM adds a helping player to a challenge: any finished character except the one rolling,
   * once, from the moment the challenge exists until it is closed (support is only *rolled* once
   * the dice are in, but it can be lined up before).
   */
  addSupporter(challengeId: string, charId: string, by: string) {
    const ch = this.challengeById(challengeId)
    const char = this.characters.get(charId)
    if (!ch || ch.groupId || ch.closed || char?.status !== 'active' || ch.charId === charId) return false
    if (ch.supporters.some((sp) => sp.charId === charId)) return false
    this.append({ type: 'challenge_supporter_added', challengeId, charId, by })
    return true
  }

  /** The GM takes a supporter off again — with their die, if they had rolled it. */
  removeSupporter(challengeId: string, charId: string, by: string) {
    const ch = this.challengeById(challengeId)
    if (!ch || ch.closed || !ch.supporters.some((sp) => sp.charId === charId)) return false
    this.append({ type: 'challenge_supporter_removed', challengeId, charId, by })
    return true
  }

  /**
   * A supporter rolls their one die: one of their abilities (at its current rank) onto the
   * framing or the resolution. Only once the challenge's dice are in and until it is closed, only
   * once per supporter, and only onto a framing that exists. The stamina/willpower it costs is the
   * player's to take off their sheet.
   */
  rollSupport(challengeId: string, charId: string, roll: ChallengeRoll, ability: string, by: string) {
    const ch = this.challengeById(challengeId)
    const sp = ch?.supporters.find((x) => x.charId === charId)
    const char = this.characters.get(charId)
    if (!ch || !sp || sp.die || ch.closed || !this.hasRolled(ch) || char?.status !== 'active') return false
    if (!this.rollsInPlay(ch).includes(roll)) return false
    if (!this.isAbilityField(ability)) return false
    const { face, value } = rollOneFace(Number(this.valueOf(char, this.rules.fields.get(ability)!)))
    this.append({ type: 'challenge_support_rolled', challengeId, charId, roll, ability, face, value, by })
    return true
  }

  /** Exertion earned but not yet spent on a roll or a reroll. It carries across both rolls. */
  availableExertion(ch: Challenge) {
    return ch.exertionGained - ch.exertionFraming - ch.exertionResolution - ch.rerolls
  }

  /** The challenge's player, if the dice are in, it is open and it is theirs to act on. */
  private actingCharacter(challengeId: string, charId: string) {
    const ch = this.challengeById(challengeId)
    // Any roll in: a challenge's land together, an attack's hit comes first on its own.
    if (!ch || ch.closed || !this.hasRolled(ch) || ch.charId !== charId) return null
    const char = this.characters.get(charId)
    return char?.status === 'active' ? { ch, char } : null
  }

  /**
   * A challenge the GM (`charId` null) or its rolling player may hand-edit: rolled and still open.
   * The same rule as everything else the player does after the roll; the GM has no character.
   */
  private editableChallenge(challengeId: string, charId: string | null) {
    if (charId !== null) return this.actingCharacter(challengeId, charId)?.ch ?? null
    const ch = this.challengeById(challengeId)
    return ch && !ch.closed && this.hasRolled(ch) ? ch : null
  }

  /**
   * The "custom" ±1 on one roll (user decision): the GM and the rolling player both have it, and
   * it lands straight on that roll's sum — shown in the breakdown as "Custom". A point on the
   * framing moves the ladder rung, and so the resolution's bonus, like exertion does.
   */
  adjustCustom(challengeId: string, charId: string | null, roll: ChallengeRoll, delta: number, by: string) {
    const ch = this.editableChallenge(challengeId, charId)
    if (!ch || (delta !== 1 && delta !== -1) || !ch[roll] || !this.rollsInPlay(ch).includes(roll)) return false
    const value = (roll === 'framing' ? ch.customFraming : ch.customResolution) + delta
    this.append({ type: 'challenge_custom_set', challengeId, roll, value, by })
    return true
  }

  /**
   * "Set die value": puts one die of a roll straight onto a chosen face (user decision), for the
   * GM or the rolling player. Any die in play may be set, added ones included; a discarded die is
   * out. The die keeps its own rank shift, so the value stays in step with how it was rolled, and
   * it is marked "Set". Picking the face it already shows changes nothing and is refused.
   */
  setDieFace(challengeId: string, charId: string | null, roll: ChallengeRoll, index: number, face: number, by: string) {
    const ch = this.editableChallenge(challengeId, charId)
    const rolled = ch && this.dieInPlay(ch, roll, index)
    if (!rolled?.faces) return false
    const { faces } = this.rules.challenges
    const legal = faces.length ? faces.some((f) => f.value === face) : Number.isInteger(face) && face >= 1 && face <= 6
    if (!legal || rolled.faces[index] === face) return false
    const value = face + (rolled.dice[index]! - rolled.faces[index]!)
    this.append({ type: 'challenge_die_set', challengeId, roll, index, face, value, by })
    return true
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

  /**
   * Spends one exertion as +1 on one roll's result. Both land together, so the player picks
   * which — and a point put on the framing can still move the resolution's target, since the
   * ladder rung is worked out live.
   */
  spendExertion(challengeId: string, charId: string, roll: ChallengeRoll, by: string) {
    const acting = this.actingCharacter(challengeId, charId)
    if (!acting || this.availableExertion(acting.ch) <= 0) return false
    if (acting.ch.exertionRerollArmed) return false // this point is already going on a reroll
    if (!this.rollsInPlay(acting.ch).includes(roll)) return false // nothing framed, or an attack's locked hit
    this.append({ type: 'challenge_exertion_spent', challengeId, roll, by })
    return true
  }

  /**
   * The player's choice for a point of exertion: `armed` = "Reroll a die" (the dice become tap
   * targets), false = back out of it. Arming needs a point in hand and no approach effect waiting
   * for its own taps, since that effect owns the dice while it lasts.
   */
  setExertionReroll(challengeId: string, charId: string, armed: boolean, by: string) {
    const acting = this.actingCharacter(challengeId, charId)
    if (!acting || acting.ch.exertionRerollArmed === armed) return false
    if (armed && (this.availableExertion(acting.ch) <= 0 || acting.ch.approachPicksLeft > 0)) return false
    this.append({ type: 'challenge_exertion_reroll_armed', challengeId, armed, by })
    return true
  }

  /**
   * Spends one exertion to reroll a single die of either roll, keeping the new face — once the
   * player has chosen "Reroll a die" (setExertionReroll). **Any** die there is fair game,
   * including ones an approach effect added (index 2 and up) — only a discarded die is out, since
   * it no longer counts. Rerolling a framing die re-reads the ladder, so the resolution's target
   * follows it.
   */
  rerollDie(challengeId: string, charId: string, roll: ChallengeRoll, index: number, by: string) {
    const acting = this.actingCharacter(challengeId, charId)
    if (!acting || this.availableExertion(acting.ch) <= 0) return false
    const { ch } = acting
    if (!ch.exertionRerollArmed || ch.approachPicksLeft > 0) return false
    if (!this.dieInPlay(ch, roll, index)) return false
    const rank = this.challengeRank(ch, roll)
    if (rank === null) return false
    const { face, value } = rollOneFace(rank)
    this.append({ type: 'challenge_rerolled', challengeId, roll, index, face, value, by })
    return true
  }

  /**
   * GM circumstance modifier: nudges the challenge's one difficulty by `delta` (the board's − and
   * + buttons), clamped to ±MAX_CIRCUMSTANCE. A plus raises the number to reach — see
   * Challenge.circumstance. Allowed from the moment the challenge is started until the GM closes
   * it, so a ruling that lands mid-roll still counts; both targets, the framing rung and every
   * screen follow it live.
   */
  adjustCircumstance(challengeId: string, delta: number, by: string) {
    const ch = this.challengeById(challengeId)
    // A group task's difficulty is set before the players are invited, not nudged afterwards.
    if (!ch || ch.groupId || ch.closed || !Number.isFinite(delta)) return false
    const value = Math.max(-MAX_CIRCUMSTANCE, Math.min(MAX_CIRCUMSTANCE, ch.circumstance + Math.round(delta)))
    if (value === ch.circumstance) return false // already at the end of the range, or a delta of 0
    this.append({ type: 'challenge_circumstance_set', challengeId, value, by })
    return true
  }

  /** GM accepts the result: the challenge stops taking input. */
  closeChallenge(challengeId: string, by: string) {
    const ch = this.challengeById(challengeId)
    if (!ch || ch.groupId || ch.closed) return false // a group closes as one
    // A challenge once its dice are in; an attack once the damage is — or straight after a miss;
    // a magic roll once control is — or at a magnitude with no success (it fizzled).
    const firstAlone = ch.attack
      ? !!this.challengeMath(ch).attack?.tier?.miss
      : ch.magic
        ? !!ch.framing && this.challengeMath(ch).magic?.successes === 0
        : false
    if (!ch.resolution && !firstAlone) return false
    // An attack's wounds land on the enemy now, as the GM accepts the result.
    const wounds = ch.attack ? (this.challengeMath(ch).attack?.wounds ?? 0) : undefined
    this.append({ type: 'challenge_closed', challengeId, wounds, by })
    return true
  }

  /** The GM's most recent solo roll, if there is one. */
  currentSoloRoll(): SoloRoll | null {
    return this.soloRolls.at(-1) ?? null
  }

  /**
   * Rolls the GM's solo roll: two dice at `rank`, against `difficulty`. The rank is held to the
   * ladder the sheet's own abilities use (abilityRankRange) so it cannot be set to something the
   * dice maths was never meant for; the opposition number is free, since the GM nudges it by 1s
   * off whichever tier they started from.
   */
  rollSolo(
    opts: { description?: string; difficulty: number; tier?: string | null; rank: number; visibility: SoloVisibility },
    by: string,
  ) {
    if (!Number.isFinite(opts.difficulty) || !Number.isFinite(opts.rank)) return null
    const { min, max } = abilityRankRange(this.rules)
    const rank = Math.round(opts.rank)
    if (rank < min || rank > max) return null
    const difficulty = Math.round(opts.difficulty)
    // The tier only names the number; drop it once a nudge has moved it off that tier's value.
    const tier = this.rules.challenges.difficulties.find((d) => d.id === opts.tier) ?? null
    return this.append({
      type: 'solo_rolled',
      soloId: crypto.randomUUID().slice(0, 8),
      description: (opts.description ?? '').trim().slice(0, 200),
      difficulty,
      tier: tier && tier.value === difficulty ? tier.label : null,
      rank,
      roll: rollChallengeSide(rank),
      visibility: opts.visibility === 'public' ? 'public' : 'gm',
      by,
    })
  }

  /** Reveals a private solo roll to the table, or takes a public one back. */
  setSoloVisibility(soloId: string, visibility: SoloVisibility, by: string) {
    const solo = this.soloRolls.find((x) => x.id === soloId)
    if (!solo || solo.visibility === visibility) return false
    this.append({ type: 'solo_visibility_set', soloId, visibility, by })
    return true
  }

  /**
   * A solo roll against its opposition number. Solo rolls have no stakes, so this is worked out
   * at `low` — pass/fail and by how much, and never a boon or a complication.
   */
  soloOutcome(solo: SoloRoll): SideOutcome {
    return outcomeFor(solo.roll.sum, solo.difficulty, 'low')
  }

  // ---- bestiary & encounter ------------------------------------------------
  // The Bestiary plans (validates) each GM action; the session logs it. Each returns whether
  // anything changed. Not undoable, like the rest of the GM's tools.
  private logEnemy(data: EnemyEventData | null) {
    if (!data) return false
    this.append(data)
    return true
  }

  saveEnemyTemplate(input: { id?: string; name: string; description?: string; stats: Record<string, unknown> }, by: string) {
    return this.logEnemy(this.bestiary.planSaveTemplate(input, by))
  }

  deleteEnemyTemplate(templateId: string, by: string) {
    return this.logEnemy(this.bestiary.planDeleteTemplate(templateId, by))
  }

  resetEnemyTemplate(templateId: string, by: string) {
    return this.logEnemy(this.bestiary.planResetTemplate(templateId, by))
  }

  spawnEnemies(templateId: string, count: number, by: string) {
    return this.logEnemy(this.bestiary.planSpawn(templateId, count, by))
  }

  updateEnemy(enemyId: string, field: string, value: string, by: string) {
    return this.logEnemy(this.bestiary.planUpdate(enemyId, field, value, by))
  }

  adjustEnemyPool(enemyId: string, pool: 'health' | 'mind', delta: number, by: string) {
    return this.logEnemy(this.bestiary.planAdjustPool(enemyId, pool, delta, by))
  }

  removeEnemies(which: 'defeated' | 'all' | string[], by: string) {
    return this.logEnemy(this.bestiary.planRemove(which, by))
  }

  // ---- boons & complications ----------------------------------------------
  /**
   * The GM rolls on the boon or complication table (rules `consequences`) at a rank they picked:
   * one die with a side per face of the table (d5 for five faces), and that face's entry at that
   * rank. A private lookup for the GM — nothing is logged or shown to anyone else, and nothing is
   * applied to a sheet. Null for a rank the table doesn't have, or with no tables configured.
   */
  rollConsequence(kind: 'boon' | 'complication', rank: number, rng: (sides: number) => number = cryptoRng) {
    const config = this.rules.consequences
    if (!config || !Number.isInteger(rank) || rank < 1 || rank > config.ranks) return null
    const table = config[kind]
    const sides = table.faces.length
    const face = rng(sides)
    return { kind, label: table.label, rank, sides, face, entry: table.faces[face - 1]![rank - 1]! }
  }

  // ---- opposition rolls --------------------------------------------------
  /** The opposition roll currently on the board, if any — always the most recently started. */
  currentOpposition(): Opposition | null {
    return this.oppositions.at(-1) ?? null
  }

  /** One contestant by side, or null when there is no such opposition roll. */
  private contestantOf(oppositionId: string, side: OppositionSide): Contestant | null {
    return this.oppositions.find((x) => x.id === oppositionId)?.[side] ?? null
  }

  /**
   * Commit → roll → done. Both sides ready reveals the commitments and opens Roll; both rolled
   * ends it, and nothing can be changed after that (user decision).
   */
  oppositionPhase(opp: Opposition): OppositionPhase {
    if (opp.a.resolution && opp.b.resolution) return 'done'
    return opp.a.ready && opp.b.ready ? 'rolling' : 'committing'
  }

  /**
   * Whether `viewer` may see what this side has committed. Hidden from the other contestant (and
   * from the shared screen, which both of them can see) until both are ready; a player always
   * sees their own, and the GM sees everything because they are refereeing, not competing.
   */
  oppositionCommitVisible(
    opp: Opposition,
    side: OppositionSide,
    role: 'gm' | 'player' | 'table',
    viewerCharId?: string,
  ) {
    if (role === 'gm' || this.oppositionPhase(opp) !== 'committing') return true
    const one = opp[side]
    return !!one.charId && one.charId === viewerCharId
  }

  /** The rank a contestant rolls a check at: off the sheet for a character, flat for an NPC. */
  private contestantRank(one: Contestant, check: ChallengeRoll): number | null {
    if (!one.charId) return check === 'framing' ? one.framingRank : one.resolutionRank
    const char = this.characters.get(one.charId)
    const abilityId = check === 'framing' ? one.framingAbility : one.resolutionAbility
    const field = abilityId ? this.rules.fields.get(abilityId) : undefined
    if (!char || !field || field.type !== 'number') return null
    return Number(this.valueOf(char, field))
  }

  /**
   * A contestant's own total for one check: the dice, the exertion put on it, and the declared
   * skill's rank (on both checks). The framing rung's bonus to the resolution is **not** in here —
   * it depends on the other side's framing, so it only exists in oppositionOutcome.
   */
  oppositionSum(one: Contestant, check: ChallengeRoll): number | null {
    const rolled = one[check]
    if (!rolled) return null
    const exertion = check === 'framing' ? one.exertionFraming : one.exertionResolution
    return rolled.sum + exertion + this.oppositionSkillBonus(one)
  }

  /**
   * The declared skill's rank, added to **each** of the contestant's checks — the same rule as a
   * challenge's skill (user decision). 0 with no skill, for an NPC, or once the field has gone.
   */
  oppositionSkillBonus(one: Contestant) {
    const char = one.charId ? this.characters.get(one.charId) : null
    const field = one.skill ? (this.rules.fields.get(one.skill) as NumberField | undefined) : undefined
    if (!char || !field) return 0
    return Math.max(0, Math.round(Number(this.baseOf(char, field))) + this.itemBonus(char, field.id))
  }

  /**
   * How the contest came out, or null until both sides have rolled — see OppositionOutcome.
   * Degrees come from the deciding check's margin at **high stakes** (user decision: always
   * high), read through outcomeFor like every other degree.
   */
  oppositionOutcome(opp: Opposition): OppositionOutcome | null {
    if (this.oppositionPhase(opp) !== 'done') return null
    const compare = (aSum: number, bSum: number): OppositionCheck => {
      const margin = aSum - bSum
      return { aSum, bSum, margin, winner: margin === 0 ? null : margin > 0 ? 'a' : 'b' }
    }
    const framing = compare(this.oppositionSum(opp.a, 'framing') ?? 0, this.oppositionSum(opp.b, 'framing') ?? 0)
    const ladder = this.rules.challenges.framing
    // Each side reads its own margin against the other: the same ladder a challenge uses.
    const rungs = { a: framingRung(ladder, framing.margin), b: framingRung(ladder, -framing.margin) }
    const resolution = compare(
      (this.oppositionSum(opp.a, 'resolution') ?? 0) + (rungs.a?.resolutionBonus ?? 0),
      (this.oppositionSum(opp.b, 'resolution') ?? 0) + (rungs.b?.resolutionBonus ?? 0),
    )
    const decidedBy = resolution.winner ? 'resolution' : framing.winner ? 'framing' : null
    const deciding = decidedBy === 'resolution' ? resolution : decidedBy === 'framing' ? framing : null
    // outcomeFor keeps the degree rule in one place: sum vs the opponent's sum, at high stakes.
    const degrees = deciding ? Math.abs(outcomeFor(deciding.aSum, deciding.bSum, 'high').degrees) : 0
    return { framing, rungs, resolution, winner: deciding?.winner ?? null, decidedBy, degrees }
  }

  /**
   * GM sets up a contest. Each side is either a character with two of its abilities (framing and
   * resolution), or an NPC with two flat ranks. An NPC's ranks are held to the ladder the sheet's
   * abilities use, the same as a solo roll.
   */
  startOpposition(
    opts: {
      description: string
      a: ContestantSetup
      b: ContestantSetup
    },
    by: string,
  ) {
    const description = opts.description.trim().slice(0, 200)
    if (!description) return null // the GM names every contest, as with challenges
    const ladder = abilityRankRange(this.rules)
    const build = (raw: ContestantSetup): Contestant | null => {
      if (raw.charId) {
        const char = this.characters.get(raw.charId)
        if (!char || char.status !== 'active') return null
        if (!this.isAbilityField(raw.framingAbility ?? '') || !this.isAbilityField(raw.resolutionAbility ?? '')) {
          return null
        }
        return contestantFromLog({
          charId: char.id,
          name: char.name,
          framingAbility: raw.framingAbility,
          resolutionAbility: raw.resolutionAbility,
        })
      }
      const framingRank = Math.round(Number(raw.framingRank))
      const resolutionRank = Math.round(Number(raw.resolutionRank))
      for (const r of [framingRank, resolutionRank]) {
        if (!Number.isFinite(r) || r < ladder.min || r > ladder.max) return null
      }
      return contestantFromLog({ charId: null, name: cleanName(raw.name ?? '') || 'NPC', framingRank, resolutionRank })
    }
    const a = build(opts.a)
    const b = build(opts.b)
    if (!a || !b) return null
    return this.append({
      type: 'opposition_started',
      oppositionId: crypto.randomUUID().slice(0, 8),
      description,
      a,
      b,
      by,
    })
  }

  /** The side this character is on, with its contestant — or null when they are not in it. */
  private oppositionSideOf(oppositionId: string, charId: string) {
    const opp = this.oppositions.find((x) => x.id === oppositionId)
    if (!opp) return null
    const side: OppositionSide | null = opp.a.charId === charId ? 'a' : opp.b.charId === charId ? 'b' : null
    return side ? { opp, side, one: opp[side] } : null
  }

  /** A side that may still change its commitment: in the contest, still committing, not ready. */
  private committing(oppositionId: string, charId: string) {
    const found = this.oppositionSideOf(oppositionId, charId)
    if (!found || found.opp.closed || this.oppositionPhase(found.opp) !== 'committing' || found.one.ready) return null
    const char = this.characters.get(charId)
    return char?.status === 'active' ? { ...found, char } : null
  }

  /**
   * Commits one point of a pool stat (stamina/willpower) to one of this side's checks, worth +1.
   * Unlike a challenge's exertion this is spent **before** the dice, and cannot be taken back.
   */
  commitOppositionExertion(oppositionId: string, charId: string, check: ChallengeRoll, statId: string, by: string) {
    const acting = this.committing(oppositionId, charId)
    if (!acting || !this.rules.challenges.exertionSources.includes(statId)) return false
    const stat = this.statOf(acting.char, statId)
    if (!stat || stat.current <= 0) return false
    const to = stat.current - 1
    this.append({
      type: 'opposition_exerted',
      oppositionId,
      side: acting.side,
      check,
      charId,
      stat: statId,
      adj: to - stat.normal,
      from: stat.current,
      to,
      by,
    })
    return true
  }

  /** Declares (or clears) the trained skill this side commits, resetting how it was split. */
  setOppositionSkill(oppositionId: string, charId: string, skill: string | null, by: string) {
    const acting = this.committing(oppositionId, charId)
    if (!acting) return false
    if (skill !== null) {
      const f = this.rules.fields.get(skill)
      if (!f || f.type !== 'number' || !f.trained) return false
      const char = this.characters.get(charId)
      if (char && !this.fieldVisible(char, f.id)) return false // a hidden (e.g. magical) skill
    }
    this.append({ type: 'opposition_skill_set', oppositionId, side: acting.side, skill, by })
    return true
  }

  /**
   * Presses Ready for one side, which locks its commitment. It can be taken back only while the
   * other side is still committing — once both are ready the commitments are revealed, so there
   * is no going back from that. The GM may ready any side (there is no permission system, and an
   * NPC has nobody else to do it).
   */
  setOppositionReady(oppositionId: string, side: OppositionSide, ready: boolean, by: string) {
    const opp = this.oppositions.find((x) => x.id === oppositionId)
    if (!opp || opp.closed || this.oppositionPhase(opp) !== 'committing') return false
    if (opp[side].ready === ready) return false
    this.append({ type: 'opposition_ready_set', oppositionId, side, ready, by })
    return true
  }

  /**
   * "Complete opposition challenge": the GM ends the contest, rolled or not. Nothing can be
   * changed after that, and the players in it no longer see it.
   */
  closeOpposition(oppositionId: string, by: string) {
    const opp = this.oppositions.find((x) => x.id === oppositionId)
    if (!opp || opp.closed) return false
    this.append({ type: 'opposition_closed', oppositionId, by })
    return true
  }

  /** Rolls one side's two checks, once both sides are ready. Once per side. */
  rollOpposition(oppositionId: string, side: OppositionSide, by: string) {
    const opp = this.oppositions.find((x) => x.id === oppositionId)
    if (!opp || opp.closed || !opp.a.ready || !opp.b.ready) return false
    const one = opp[side]
    if (one.resolution) return false // already rolled
    const framingRank = this.contestantRank(one, 'framing')
    const resolutionRank = this.contestantRank(one, 'resolution')
    if (framingRank === null || resolutionRank === null) return false
    this.append({
      type: 'opposition_rolled',
      oppositionId,
      side,
      framing: rollChallengeSide(framingRank),
      resolution: rollChallengeSide(resolutionRank),
      by,
    })
    return true
  }

  /** The declared skill's name and icon, for its bonus chip; null with none declared. */
  oppositionSkillState(one: Contestant) {
    const field = one.skill ? (this.rules.fields.get(one.skill) as NumberField | undefined) : undefined
    return field ? { label: field.label, icon: field.icon ?? null } : null
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
