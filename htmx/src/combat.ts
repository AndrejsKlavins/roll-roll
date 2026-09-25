// Combat arithmetic (user-designed), shared by a player's attack (a challenge whose framing is
// the hit roll and whose resolution is the damage roll) and an enemy's attack (rolled in one go).
//
// Hit roll − the defender's Evasion → a hit tier, which changes the damage roll:
//   −3 or less  Miss            no damage
//   −2, −1      Glancing blow   the highest damage die is discarded
//   0 … +2      Normal hit
//   +3 … +5     Good hit        +1 damage
//   +6 … +8     Great hit       +2 damage
//   +9 and up   Critical hit    one extra damage die (not cumulative: no +2)
// Damage roll − the defender's Physical resistance → wounds: below 0 none, then
// 1 + floor(margin / 3) — light (−1), normal (−2), heavy (−3), and so on, uncapped.
//
// Once something has been attacked in a round its Evasion is spent: every later attack on it that
// round rolls against Evasion 0 (it can still miss or glance, and can land better hits).
import type { ChallengeSide } from './session'

export type HitTier = {
  id: 'miss' | 'glancing' | 'normal' | 'good' | 'great' | 'critical'
  label: string
  /** Lowest hit margin that reaches this tier. */
  from: number
  /** Flat bonus on the damage roll. */
  damageBonus: number
  /** Glancing: the highest damage die is discarded. */
  drop: boolean
  /** Critical: one more damage die. */
  extraDie: boolean
  /** No damage at all. */
  miss: boolean
}

const tier = (t: Partial<HitTier> & Pick<HitTier, 'id' | 'label' | 'from'>): HitTier => ({
  damageBonus: 0,
  drop: false,
  extraDie: false,
  miss: false,
  ...t,
})

export const HIT_TIERS: HitTier[] = [
  tier({ id: 'miss', label: 'Miss', from: -Infinity, miss: true }),
  tier({ id: 'glancing', label: 'Glancing blow', from: -2, drop: true }),
  tier({ id: 'normal', label: 'Normal hit', from: 0 }),
  tier({ id: 'good', label: 'Good hit', from: 3, damageBonus: 1 }),
  tier({ id: 'great', label: 'Great hit', from: 6, damageBonus: 2 }),
  tier({ id: 'critical', label: 'Critical hit', from: 9, extraDie: true }),
]

export function hitTier(margin: number): HitTier {
  return [...HIT_TIERS].reverse().find((t) => margin >= t.from)!
}

/** Points the hit still needs to reach the next tier; null at a critical. */
export function pointsToNextTier(margin: number): number | null {
  const next = HIT_TIERS.find((t) => t.from > margin)
  return next ? next.from - margin : null
}

/** What a tier does to the damage roll, in words ("+1 to damage", "no damage"…). */
export function tierEffect(t: HitTier): string {
  if (t.miss) return 'no damage'
  if (t.drop) return 'highest damage die discarded'
  if (t.extraDie) return 'an extra damage die'
  if (t.damageBonus) return `+${t.damageBonus} to damage`
  return 'damage as rolled'
}

/** Wounds (points of Health or Mind lost) for a damage margin. */
export function woundsFor(margin: number): number {
  return margin < 0 ? 0 : 1 + Math.floor(margin / 3)
}

/** Points the damage still needs for one more wound. */
export function pointsToNextWound(margin: number): number {
  return margin < 0 ? -margin : 3 - (margin % 3)
}

export function woundLabel(wounds: number): string {
  if (wounds <= 0) return 'No damage'
  if (wounds === 1) return 'Light wound'
  if (wounds === 2) return 'Normal wound'
  if (wounds === 3) return 'Heavy wound'
  return `Grievous wound`
}

/**
 * Glancing blow: which damage die is discarded — the highest of the dice the roll was **rolled
 * with** (the first `base`), among those still counting. A die added afterwards (an approach
 * effect) is never the one dropped in its place (user decision: "it is dropped and that is it").
 */
export function glancingDrop(side: ChallengeSide, base = 2): number | null {
  let best: number | null = null
  for (let i = 0; i < Math.min(base, side.dice.length); i++) {
    if (side.discarded?.[i]) continue
    if (best === null || side.dice[i]! > side.dice[best]!) best = i
  }
  return best
}

/** The three defences an attack can be rolled against, and the pools wounds can come off. */
export type Defence = 'evasion' | 'physical' | 'mental'
export type WoundPool = 'health' | 'mind'

export const DEFENCES: { id: Defence; label: string; short: string; enemyKey: 'evasion' | 'physicalResistance' | 'mentalResistance'; charStat: string }[] = [
  { id: 'evasion', label: 'Evasion', short: 'Evasion', enemyKey: 'evasion', charStat: 'evasion' },
  { id: 'physical', label: 'Physical resistance', short: 'Phys res', enemyKey: 'physicalResistance', charStat: 'physical_resistance' },
  { id: 'mental', label: 'Mental resistance', short: 'Ment res', enemyKey: 'mentalResistance', charStat: 'mental_resistance' },
]
export const defence = (id: Defence) => DEFENCES.find((d) => d.id === id)!
export const isDefence = (id: unknown): id is Defence => DEFENCES.some((d) => d.id === id)

export const WOUND_POOLS: { id: WoundPool; label: string }[] = [
  { id: 'health', label: 'Health' },
  { id: 'mind', label: 'Mind' },
]
export const isWoundPool = (id: unknown): id is WoundPool => id === 'health' || id === 'mind'
export const poolLabel = (id: WoundPool) => (id === 'health' ? 'Health' : 'Mind')

/** Item-only stats an attacker's enabled equipment adds (rules.yaml `equipment.item_stats`). */
export const ACCURACY_STAT = 'attack_accuracy'
export const DAMAGE_STAT = 'attack_damage'

/** The target number a hit roll goes against: spent Evasion is 0 (only Evasion is ever spent). */
export const hitTargetOf = (vs: Defence, value: number, evasionSpent: boolean) => (vs === 'evasion' && evasionSpent ? 0 : value)
