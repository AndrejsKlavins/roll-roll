// Spinner challenge check (user-designed): an alternative to the dice challenge. One spinner,
// its segments worst to best (rules.yaml `spinner`). It is rolled in two steps (user decision):
// 1. Spin the framing: one spin + skill + circumstance (+ exertion) vs the difficulty. The player
//    may exert on it (+1, or a re-spin that counts instead) until they accept it.
// 2. Accepting spins the resolution: the framing's margin gives advantage N (spin N+1 spinners and
//    keep the best) or disadvantage N (keep the worst). Exertion works on it the same way.
// Each ability rank away from 3 shifts every segment's value by `shift_per_rank`.
import { cryptoRng } from './engine/expr'
import type { SpinnerConfig } from './rules'

/** One spin: which segment the arrow stopped on, and what it counts for (value + ability shift). */
export type Spin = { segment: number; value: number; /** Bought with exertion; it counts. */ respin?: boolean }
/** One roll's spinners: the rank they were spun at, every spin, and the one that counts. */
export type SpinnerRoll = { rank: number; spins: Spin[]; kept: number }
export type SpinnerStep = 'framing' | 'resolution'
/** What exertion buys on a spin: +1 on its sum, or one more spin that counts instead. */
export type SpinnerExertKind = 'bonus' | 'respin'

export type SpinnerCheck = {
  id: string
  /** The id of the event that started it — places it in the table's history log. */
  seq: number
  description: string
  difficulty: number
  /** The difficulty tier's name while the number is still that tier's. */
  tier: string | null
  /** Null when the GM skipped the framing: Spin goes straight to one resolution spinner. */
  framingAbility: string | null
  resolutionAbility: string
  charId: string
  skill: string | null
  /** The skill's bonus as it stood at the framing spin (it rides on both rolls). */
  skillBonus: number
  framing: SpinnerRoll | null
  /** Set when the framing is accepted; it decided how many resolution spinners there are. */
  advantage: number | null
  resolution: SpinnerRoll | null
  /** The player's or GM's own ± on each roll (a plus helps). The framing's is fixed once accepted. */
  circumstance: Record<SpinnerStep, number>
  /** +1s bought with exertion on each roll. */
  exertion: Record<SpinnerStep, number>
  closed: boolean
  by: string
}

/** A circumstance on one roll is held to ±this. */
export const MAX_SPINNER_CIRCUMSTANCE = 10

/** The pool point an exertion burnt; `adj` is the pool's new play change, like a challenge's. */
type PoolSpend = { charId: string; stat: string; adj: number; from: number; to: number }

export type SpinnerEventData =
  | {
      type: 'spinner_started'
      checkId: string
      description: string
      difficulty: number
      tier: string | null
      framingAbility: string | null
      resolutionAbility: string
      charId: string
      by: string
    }
  | { type: 'spinner_skill_set'; checkId: string; skill: string | null; by: string }
  // The first Spin: the framing — or, with the framing skipped (framing null), the resolution
  // straight away at advantage 0. (Logs from before the two steps carry both.)
  | {
      type: 'spinner_spun'
      checkId: string
      skill: string | null
      skillBonus: number
      framing: SpinnerRoll | null
      advantage?: number
      resolution?: SpinnerRoll
      by: string
    }
  // The framing accepted: the advantage it earned and the resolution's spins.
  | { type: 'spinner_resolution_spun'; checkId: string; advantage: number; resolution: SpinnerRoll; by: string }
  | { type: 'spinner_closed'; checkId: string; by: string }
  // `value` is the whole new circumstance, so a replay lands on the same number.
  | { type: 'spinner_circumstance_set'; checkId: string; roll: SpinnerStep; value: number; by: string }
  // +1 on a roll. `roll` is absent on logs from when exertion was resolution-only.
  | ({ type: 'spinner_exerted'; checkId: string; roll?: SpinnerStep; by: string } & PoolSpend)
  // One more spin on a roll, which counts instead of the one before.
  | ({ type: 'spinner_respun'; checkId: string; roll: SpinnerStep; spin: Spin; by: string } & PoolSpend)

const SPINNER_EVENT_TYPES = new Set<string>([
  'spinner_started',
  'spinner_skill_set',
  'spinner_spun',
  'spinner_resolution_spun',
  'spinner_closed',
  'spinner_circumstance_set',
  'spinner_exerted',
  'spinner_respun',
])

export const isSpinnerEvent = (e: { type: string }): e is SpinnerEventData => SPINNER_EVENT_TYPES.has(e.type)

/** How much an ability rank shifts every segment: (rank − 3) × shift_per_rank. */
export const spinnerShift = (config: SpinnerConfig, rank: number) => (Math.round(rank) - 3) * config.shiftPerRank

/** One spin at `rank`. `rng(n)` returns 1..n. */
export function spinOnce(config: SpinnerConfig, rank: number, rng: (sides: number) => number = cryptoRng): Spin {
  const segment = rng(config.segments.length) - 1
  return { segment, value: config.segments[segment]!.value + spinnerShift(config, rank) }
}

/**
 * Spins `count` spinners at `rank` and picks the one that counts: the best, or with `keep: 'worst'`
 * the worst (the first of equals).
 */
export function spin(
  config: SpinnerConfig,
  rank: number,
  count: number,
  keep: 'best' | 'worst',
  rng: (sides: number) => number = cryptoRng,
): SpinnerRoll {
  const spins = Array.from({ length: Math.max(1, count) }, () => spinOnce(config, rank, rng))
  let kept = 0
  spins.forEach((s, i) => {
    if (keep === 'best' ? s.value > spins[kept]!.value : s.value < spins[kept]!.value) kept = i
  })
  return { rank: Math.round(rank), spins, kept }
}

/** The step that is open to changes (exertion, the framing's circumstance), or null. */
export function spinnerOpenStep(check: SpinnerCheck): SpinnerStep | null {
  if (check.closed) return null
  return check.resolution ? 'resolution' : check.framing ? 'framing' : null
}

/** One roll's sum: the kept spin, then each addition (0 when it adds nothing), the total and margin. */
export type SpinnerSide = { value: number; skill: number; circumstance: number; exertion: number; total: number; margin: number }

export type SpinnerCheckMath = {
  framing: SpinnerSide | null
  resolution: SpinnerSide | null
  /** Null until the framing is accepted. */
  advantage: number | null
  /** Null until the resolution is spun. */
  success: boolean | null
}

/** A check's numbers — every screen and the history log read them from here. */
export function spinnerMath(check: SpinnerCheck): SpinnerCheckMath {
  const side = (roll: SpinnerRoll | null, step: SpinnerStep): SpinnerSide | null => {
    if (!roll) return null
    const value = roll.spins[roll.kept]!.value
    const circumstance = check.circumstance[step]
    const exertion = check.exertion[step]
    const total = value + check.skillBonus + circumstance + exertion
    return { value, skill: check.skillBonus, circumstance, exertion, total, margin: total - check.difficulty }
  }
  const resolution = side(check.resolution, 'resolution')
  return {
    framing: side(check.framing, 'framing'),
    resolution,
    advantage: check.advantage,
    success: resolution ? resolution.margin >= 0 : null,
  }
}

/** Spinner checks ever started, in order; the last is the one on the board. Rebuilt from the log. */
export class SpinnerChecks {
  readonly list: SpinnerCheck[] = []

  reset() {
    this.list.length = 0
  }

  current(): SpinnerCheck | null {
    return this.list.at(-1) ?? null
  }

  byId(id: string) {
    return this.list.find((c) => c.id === id) ?? null
  }

  apply(e: SpinnerEventData & { id: number; ts?: number }) {
    if (e.type === 'spinner_started') {
      const { type: _type, checkId, id, ts: _ts, ...rest } = e
      this.list.push({
        ...rest,
        id: checkId,
        seq: id,
        skill: null,
        skillBonus: 0,
        framing: null,
        advantage: null,
        resolution: null,
        circumstance: { framing: 0, resolution: 0 },
        exertion: { framing: 0, resolution: 0 },
        closed: false,
      })
      return
    }
    const check = this.byId(e.checkId)
    if (!check) return
    switch (e.type) {
      case 'spinner_skill_set':
        check.skill = e.skill
        break
      case 'spinner_spun':
        check.skill = e.skill
        check.skillBonus = e.skillBonus
        // Copies: a re-spin appends to the roll, and the logged event must stay as it was.
        check.framing = e.framing ? structuredClone(e.framing) : null
        if (e.resolution) {
          check.advantage = e.advantage ?? 0
          check.resolution = structuredClone(e.resolution)
        }
        break
      case 'spinner_resolution_spun':
        check.advantage = e.advantage
        check.resolution = structuredClone(e.resolution)
        break
      case 'spinner_closed':
        check.closed = true
        break
      case 'spinner_circumstance_set':
        check.circumstance[e.roll] = e.value
        break
      case 'spinner_exerted':
        check.exertion[e.roll ?? 'resolution'] += 1
        break
      case 'spinner_respun': {
        const roll = check[e.roll]
        if (!roll) break
        roll.spins.push({ ...e.spin })
        roll.kept = roll.spins.length - 1
        break
      }
    }
  }
}
