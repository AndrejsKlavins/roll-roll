// Loads and validates system/rules.yaml once at startup.
import { existsSync, readFileSync } from 'node:fs'
import { dirname, extname, join } from 'node:path'
import { evaluate, ExprError } from './engine/expr'

/**
 * Optional look of a field. icon is a file in system/icons/ (SVG is inlined so it can be
 * coloured by CSS; PNG/WebP/JPG are linked) or short text such as an emoji.
 */
export type Icon = { kind: 'svg'; markup: string } | { kind: 'img'; src: string } | { kind: 'text'; text: string }
/** ink: icon colour that stays readable on the colour chip (dark on light colours, white otherwise). */
type Look = { icon?: Icon; color?: string; ink?: string }

/** base: value is fixed when the character is finished; play changes are stored relative to it. */
export type NumberField = Look & {
  id: string
  label: string
  type: 'number'
  min: number
  max: number
  default: number
  base: boolean
  /** Words per value (e.g. 3 → "average"). When set, the sheet shows the word and dots instead of the number. */
  scale?: Record<number, string>
  /** Base value comes from skill points spent in training (see Rules.training), not set directly. */
  trained: boolean
}
export type TrackField = Look & { id: string; label: string; type: 'track'; max: number; default: number }
export type TextField = Look & { id: string; label: string; type: 'text'; lines: number; default: string }
export type Field = NumberField | TrackField | TextField

/**
 * Calculated, read-only value. Can sit inside a section (type: derived) to be shown with the
 * section's other rows, or in the top-level "derived:" list (shown in a compact block).
 */
export type Derived = Look & {
  id: string
  label: string
  type: 'derived'
  formula: string
  inSection: boolean
  /** Resource pool (e.g. Health): the formula is the maximum, shown as filled/empty circles. */
  pool: boolean
  /** Evaluated on base values only (ignores play changes); read-only on the sheet. */
  useBase: boolean
}
/** The character's level with a Level up button (type: level). Needs "training:". */
export type LevelItem = Look & { id: string; label: string; type: 'level' }
export type SectionItem = Field | Derived | LevelItem
export type Section = { label: string; fields: SectionItem[] }
export type RollDef = { id: string; label: string; dice: string }

/** base: value is fixed when the character is finished (untrained) or set by trained points. */
export const isBaseField = (f: Field): f is NumberField => f.type === 'number' && f.base

/**
 * A bundle of stat adjustments a player can pick during character creation (or later, if the
 * GM allows it). Cost balances against Rules.powerLevel: negative = buff, positive = flaw,
 * 0 = a mix of both. A modifier's "field" is looked up as an ability/skill first, then as a
 * derived stat: an untrained base field (ability) is nudged by "delta"; a trained field (skill)
 * is pre-loaded with "skill_points" (may push its rank up); a derived stat (e.g. Evasion) is
 * permanently shifted by "delta", on top of whatever its formula computes.
 */
export type AbilityModifier = { kind: 'ability'; field: string; delta: number }
export type SkillPointsModifier = { kind: 'skill_points'; field: string; points: number }
export type StatBonusModifier = { kind: 'stat_bonus'; stat: string; delta: number }
export type TraitModifier = AbilityModifier | SkillPointsModifier | StatBonusModifier
/**
 * A group traits are picked from (e.g. Origin). max caps how many of that group can be picked.
 * sortAlpha: offer its traits alphabetically ("sort: alpha" in rules.yaml) — otherwise they're
 * offered in rules.yaml list order (e.g. Basic follows the ability order on the sheet).
 */
export type TraitCategory = { id: string; label: string; max: number; sortAlpha: boolean }
/**
 * "tags" mark a trait as mutually exclusive with any other trait sharing a tag (e.g. a whole
 * ability's +1/+2/-1/-2 variants tagged "base_strength" so only one can ever be picked).
 */
export type Trait = {
  id: string
  label: string
  cost: number
  description: string
  category: string
  tags: string[]
  modifiers: TraitModifier[]
}

/**
 * Skill point training. Points are granted on finishing a character and on each level up
 * (the value of pointsStat), and spent on trained fields. Rank n needs thresholds[n-1] points.
 */
export type Training = { pointsStat: string; rankCosts: number[]; thresholds: number[]; maxPoints: number }

/** One rung of the challenge difficulty ladder — a GM-facing starting point, not a hard rule. */
export type Difficulty = { id: string; label: string; value: number }
/**
 * A named approach the rolling player picks. Each one rolls its own d6 (the approach die);
 * `when` says whether that die's effect applies: `always`, only while the roll is failing
 * (`failure`), or by the player's `choice` (they press Activate). Nothing applies on its own —
 * the player always presses Activate first; `when` decides whether that button is offered.
 */
export type ApproachWhen = 'always' | 'failure' | 'choice'
export type Approach = {
  id: string
  label: string
  when: ApproachWhen
  /** Free text shown next to the pick button; empty falls back to a hint made from `when`. */
  description: string
  effects: ApproachEffect[]
}
const APPROACH_WHEN: ApproachWhen[] = ['always', 'failure', 'choice']

/**
 * What one face of an approach die does, and what the player has to pick to apply it:
 * - `none` — nothing happens, so there is nothing to activate.
 * - `declare` — a ruling with no mechanics (e.g. "ignore the failure's bad news"); Activate
 *   records that it was used and asks for nothing.
 * - `discard` — the player taps one rolled die; it stops counting.
 * - `reroll` — the player taps one rolled die; it is rolled again.
 * - `extra_dice` — `dice` more dice are rolled with the resolution on Activate.
 * - `raise_face` — the player taps `dice` dice; each moves one face up (a die already on the
 *   top face stays put and the pick is spent).
 * - `set_face` — the player taps `dice` dice; each is set to `toFace`, up or down.
 *
 * Two of them are **two-step**: one effect, two taps that do different things (so `dice` does
 * not apply — they always ask for exactly the picks listed).
 * - `lower_raise` (Tweak) — tap a die to lower it one face, then another to raise it one face.
 * - `match_highest` (Perfect balance) — the resolution's lowest die rises to the face of its
 *   highest. Nothing to tap, so it applies on Activate.
 * - `discard_double` (Perfect choice) — tap a die to discard it, then another to copy (the twin
 *   joins the resolution roll and counts).
 *
 * `dice` is how many dice the effect involves: rolled (extra_dice) or tapped (raise/set).
 * The same die can't be tapped twice for one effect. Any cost ("payment") is settled at the
 * table; the app never deducts one.
 */
export type ApproachEffectKind =
  | 'none'
  | 'declare'
  | 'discard'
  | 'reroll'
  | 'extra_dice'
  | 'raise_face'
  | 'set_face'
  | 'lower_raise'
  | 'match_highest'
  | 'discard_double'
export type ApproachEffect = {
  face: number
  kind: ApproachEffectKind
  dice: number
  /** Only for `set_face`: the face id every tapped die is set to. */
  toFace: number
  label: string
}
const APPROACH_EFFECT_KINDS: ApproachEffectKind[] = [
  'none',
  'declare',
  'discard',
  'reroll',
  'extra_dice',
  'raise_face',
  'set_face',
  'lower_raise',
  'match_highest',
  'discard_double',
]
/** Kinds whose `dice` counts dice the player taps (rather than dice rolled for them). */
const TAP_KINDS: ApproachEffectKind[] = ['raise_face', 'set_face']
/** Kinds that ask for two picks doing different things; `dice` does not apply to them. */
const TWO_STEP_KINDS: ApproachEffectKind[] = ['lower_raise', 'discard_double']

const plural = (n: number) => (n === 1 ? 'die' : 'dice')
const defaultEffectLabel = (kind: ApproachEffectKind, dice: number, toFace: number) =>
  kind === 'discard'
    ? 'Discard one die'
    : kind === 'reroll'
      ? 'Reroll one die'
      : kind === 'extra_dice'
        ? `Roll ${dice} extra ${plural(dice)}`
        : kind === 'raise_face'
          ? `Raise ${dice} ${plural(dice)} one face`
          : kind === 'set_face'
            ? `Set ${dice} ${plural(dice)} to face ${toFace}`
            : kind === 'lower_raise'
              ? 'Lower one die a face, raise another'
              : kind === 'match_highest'
                ? 'The lowest die rises to the highest'
                : kind === 'discard_double'
                  ? 'Discard one die, copy another'
                  : kind === 'declare'
                    ? 'A ruling, with no dice to change'
                    : 'Nothing happens'

/** The effect of the face this approach die landed on, or null when none is configured. */
export const approachEffect = (approach: Approach, face: number) =>
  approach.effects.find((e) => e.face === face) ?? null

/**
 * How many dice applying this effect asks the player to tap. The approach die belongs to the
 * **resolution** roll alone, so the kinds that used to ask which of two abilities to act on
 * (`extra_dice`, `match_highest`) have only one side to land on and apply on Activate.
 */
export const effectPicks = (effect: ApproachEffect | null) => {
  if (!effect || effect.kind === 'none' || effect.kind === 'declare') return 0
  if (effect.kind === 'extra_dice' || effect.kind === 'match_highest') return 0
  if (TWO_STEP_KINDS.includes(effect.kind)) return 2
  return TAP_KINDS.includes(effect.kind) ? effect.dice : 1
}

/**
 * Which step of a two-step effect the player is on, from the picks still to come: `'first'` while
 * both are outstanding, `'second'` for the last one. Single-pick kinds are always `'first'`.
 */
export const effectStep = (effect: ApproachEffect | null, picksLeft: number) =>
  effect && TWO_STEP_KINDS.includes(effect.kind) && picksLeft <= 1 ? 'second' : 'first'

/** Whether applying this effect needs the player to pick a die or an ability first. */
export const effectNeedsPick = (effect: ApproachEffect | null) => effectPicks(effect) > 0

/** Whether this face is worth an Activate button at all (a blank face is not). */
export const effectCanActivate = (effect: ApproachEffect | null) => !!effect && effect.kind !== 'none'
/**
 * One rung of the framing ladder: what a framing margin of `from` or better (but short of the
 * next rung) does to the resolution roll. Both effects are **arithmetic only**, because the two
 * rolls land together and the rung is recomputed live — exertion on the framing can move the
 * resolution's target after the dice are down, which nothing dice-shaped could follow.
 *
 * - `difficulty` — moves the resolution's target; a plus makes it harder.
 * - `degrees` — a boon (positive) or a complication (negative), **added** to whatever the
 *   resolution's stakes produce.
 */
export type FramingRung = {
  /** The lowest margin this rung covers. The bottom rung catches everything below it. */
  from: number
  difficulty: number
  degrees: number
  label: string
}
/**
 * How the framing roll's margin sets up the resolution roll: a list of rungs by threshold, so
 * the bands need not be evenly spaced (the user's ladder has a narrow −1/−2 rung under an even
 * 0/+1/+2 one).
 */
export type FramingLadder = { rungs: FramingRung[] }

/** The rung a framing margin lands on: the last one it reaches, or the bottom rung below them all. */
export function framingRung(ladder: FramingLadder, margin: number): FramingRung | null {
  const { rungs } = ladder
  if (!rungs.length) return null
  return rungs.findLast((r) => margin >= r.from) ?? rungs[0]!
}

/** What a rolled die face is called, and the colour it reads in (red → green). */
export type FaceName = { value: number; label: string; color: string; ink: string }

export type ChallengesConfig = {
  difficulties: Difficulty[]
  approaches: Approach[]
  /** What the framing roll's margin does to the resolution roll. */
  framing: FramingLadder
  /** Names/colours per die face, sorted by value; faces outside the list clamp to the ends. */
  faces: FaceName[]
  /** Pool stats a player may burn for exertion during a challenge (e.g. stamina, willpower). */
  exertionSources: string[]
  /** Average gap between consecutive difficulties — used to suggest "2 ranks below" for support. */
  rankStep: number
}

export type Rules = {
  name: string
  sections: Section[]
  derived: Derived[]
  rolls: RollDef[]
  fields: Map<string, Field>
  training?: Training
  /** The "level" row, if the sheet has one. */
  level?: LevelItem
  traits: Trait[]
  traitCategories: TraitCategory[]
  /** GM's default budget target for trait costs (usually 0); adjustable at runtime. */
  powerLevel: number
  challenges: ChallengesConfig
}

/**
 * The rank ladder a solo roll may pick from, so the range stays a rules-file decision rather than
 * a number in code. It comes from the **word scale** the sheet's abilities use (rating: 0 abysmal
 * … 6 epic), not from their min/max — abilities deliberately have no fixed bounds in play, so
 * those are usually infinite. `def` is an ability's own default, for what the picker starts on.
 * Falls back to 1..5 with no words for a rules file whose abilities carry no scale.
 */
export function abilityRankRange(rules: Rules): {
  min: number
  max: number
  def: number
  scale?: Record<number, string>
} {
  const abilities = [...rules.fields.values()].filter((f): f is NumberField => isBaseField(f) && !f.trained)
  const scale = abilities.find((a) => a.scale)?.scale
  const ranks = Object.keys(scale ?? {})
    .map(Number)
    .filter(Number.isFinite)
  const def = abilities.map((a) => a.default).find(Number.isFinite) ?? 3
  if (!ranks.length) return { min: 1, max: 5, def, scale }
  return { min: Math.min(...ranks), max: Math.max(...ranks), def, scale }
}

export const RULES_PATH = join(import.meta.dir, '..', 'system', 'rules.yaml')

export async function loadRules(path = RULES_PATH): Promise<Rules> {
  const raw = Bun.YAML.parse(await Bun.file(path).text()) as any
  const errors: string[] = []
  const fail = (msg: string) => errors.push(msg)
  const ids = new Set<string>()

  const checkId = (id: unknown, where: string): id is string => {
    if (typeof id !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(id)) {
      fail(`${where}: id must be letters/digits/underscore, got ${JSON.stringify(id)}`)
      return false
    }
    if (/^d\d+$/.test(id)) fail(`${where}: id "${id}" looks like a die`)
    if (ids.has(id)) fail(`${where}: duplicate id "${id}"`)
    ids.add(id)
    return true
  }

  const iconsDir = join(dirname(path), 'icons')

  // scales: { rating: { 1: horrible, 2: low, ... } }
  const scales = new Map<string, Record<number, string>>()
  for (const [name, words] of Object.entries(raw?.scales ?? {})) {
    const scale: Record<number, string> = {}
    for (const [value, word] of Object.entries((words ?? {}) as Record<string, unknown>)) {
      if (!/^-?\d+$/.test(value)) fail(`scales.${name}: keys must be whole numbers, got "${value}"`)
      else scale[Number(value)] = String(word)
    }
    scales.set(name, scale)
  }

  const parseLook = (f: any, where: string): Look => {
    const look: Look = {}
    if (f.color !== undefined) {
      // Unquoted 899937 is a YAML number; pad in case it had leading zeros.
      const hex = (typeof f.color === 'number' ? String(f.color).padStart(6, '0') : String(f.color)).replace(/^#/, '')
      if (/^[0-9a-f]{6}$/i.test(hex)) {
        look.color = `#${hex.toLowerCase()}`
        look.ink = luminance(hex) > 0.45 ? '#1b1a1f' : '#ffffff'
      }
      else fail(`${where}: color must be a hex colour like "#99342c", got ${JSON.stringify(f.color)}`)
    }
    if (f.icon !== undefined) {
      const icon = String(f.icon)
      const ext = extname(icon).toLowerCase()
      if (['.svg', '.png', '.webp', '.jpg', '.jpeg'].includes(ext)) {
        const file = join(iconsDir, icon)
        if (!existsSync(file) || icon.includes('..')) fail(`${where}: icon file not found: system/icons/${icon}`)
        else if (ext === '.svg') look.icon = { kind: 'svg', markup: cleanSvg(readFileSync(file, 'utf8')) }
        else look.icon = { kind: 'img', src: `/system/icons/${encodeURIComponent(icon)}` }
      } else {
        look.icon = { kind: 'text', text: icon.slice(0, 4) }
      }
    }
    return look
  }

  const parseDerived = (d: any, where: string, inSection: boolean): Derived => ({
    id: d.id,
    label: String(d.label ?? d.id),
    type: 'derived',
    formula: String(d.formula ?? ''),
    inSection,
    pool: Boolean(d.pool),
    useBase: Boolean(d.base),
    ...parseLook(d, where),
  })

  const fields = new Map<string, Field>()
  const derived: Derived[] = []
  let levelItem: LevelItem | undefined
  const sections: Section[] = (raw?.sections ?? []).map((s: any, si: number) => ({
    label: String(s?.label ?? `Section ${si + 1}`),
    fields: (s?.fields ?? []).flatMap((f: any, fi: number): SectionItem[] => {
      const where = `sections[${si}].fields[${fi}]`
      if (!checkId(f?.id, where)) return []
      if (f.type === 'derived') {
        const d = parseDerived(f, where, true)
        derived.push(d)
        return [d]
      }
      if (f.type === 'level') {
        if (levelItem) fail(`${where}: only one "level" row is allowed`)
        levelItem = { id: f.id, label: String(f.label ?? 'Level'), type: 'level', ...parseLook(f, where) }
        return [levelItem]
      }
      const label = String(f.label ?? f.id)
      let field: Field
      switch (f.type) {
        case 'number': {
          // Omit min/max for a field that scales without a hard ceiling/floor (e.g. an ability
          // pushed past its scale's own top or bottom step just clamps to that step's word).
          const min = f.min !== undefined ? Number(f.min) : -Infinity
          const max = f.max !== undefined ? Number(f.max) : Infinity
          const trained = Boolean(f.trained ?? s?.trained ?? false)
          const base = trained || Boolean(f.base ?? s?.base ?? false)
          const fallbackDefault = Number.isFinite(min) ? min : 0
          field = { id: f.id, label, type: 'number', min, max, default: Number(f.default ?? fallbackDefault), base, trained }
          const scaleName = f.scale ?? s?.scale
          if (scaleName !== undefined && scaleName !== null) {
            const scale = scales.get(String(scaleName))
            if (scale) field.scale = scale
            else fail(`${where}: unknown scale "${scaleName}" (define it under "scales:")`)
          }
          break
        }
        case 'track':
          field = { id: f.id, label, type: 'track', max: Number(f.max ?? 3), default: Number(f.default ?? 0) }
          break
        case 'text':
          field = { id: f.id, label, type: 'text', lines: Number(f.lines ?? 3), default: String(f.default ?? '') }
          break
        default:
          fail(`${where}: unknown type ${JSON.stringify(f.type)} (use number, track, text, derived or level)`)
          return []
      }
      Object.assign(field, parseLook(f, where))
      fields.set(field.id, field)
      return [field]
    }),
  }))

  // Dry-run formulas against default values so typos fail at startup, not at the table.
  const scope: Record<string, number> = {}
  for (const f of fields.values()) if (f.type !== 'text') scope[f.id] = f.default
  const dryRng = () => 1

  ;(raw?.derived ?? []).forEach((d: any, i: number) => {
    if (checkId(d?.id, `derived[${i}]`)) derived.push(parseDerived(d, `derived[${i}]`, false))
  })
  // Evaluated in order: section derived values top to bottom, then the top-level list.
  for (const d of derived) {
    try {
      scope[d.id] = evaluate(d.formula, scope, { allowDice: false }).total
    } catch (e) {
      fail(`derived "${d.id}": ${(e as Error).message}`)
      scope[d.id] = 0
    }
  }

  // training: { points_stat: skill_points, rank_costs: [4, 5, 6, 7, 8] }
  let training: Training | undefined
  if (raw?.training) {
    const t = raw.training
    const pointsStat = String(t.points_stat ?? '')
    const rankCosts: number[] = Array.isArray(t.rank_costs) ? t.rank_costs.map(Number) : []
    if (!derived.some((d) => d.id === pointsStat)) fail(`training.points_stat: no derived value "${pointsStat}"`)
    if (!rankCosts.length || rankCosts.some((c) => !Number.isInteger(c) || c < 1))
      fail('training.rank_costs: must be a list of whole numbers ≥ 1, e.g. [4, 5, 6, 7, 8]')
    const thresholds = rankCosts.map((_, i) => rankCosts.slice(0, i + 1).reduce((a, b) => a + b, 0))
    training = { pointsStat, rankCosts, thresholds, maxPoints: thresholds.at(-1) ?? 0 }
  }
  const trainedFields = [...fields.values()].filter((f) => f.type === 'number' && f.trained)
  if (trainedFields.length && !training) fail('fields marked "trained" need a top-level "training:" block')
  if (levelItem && !training) fail('a "level" row needs a top-level "training:" block')

  const rolls: RollDef[] = (raw?.rolls ?? []).flatMap((r: any, i: number) => {
    const where = `rolls[${i}]`
    if (!checkId(r?.id, where)) return []
    const dice = String(r.dice ?? '')
    try {
      evaluate(dice, scope, { rng: dryRng })
    } catch (e) {
      if (e instanceof ExprError) fail(`${where} "${r.id}": ${e.message}`)
      else throw e
    }
    return [{ id: r.id, label: String(r.label ?? r.id), dice }]
  })

  // traits: { power_level: 0, categories: [{id, label, max?}], list: [{ id, label, cost, category, tags?, description?, modifiers: [{field, delta}] }] }
  const rawTraits = raw?.traits ?? {}
  const powerLevel = Number(rawTraits.power_level ?? 0)
  if (!Number.isFinite(powerLevel)) fail('traits.power_level: must be a number')

  const traitCategories: TraitCategory[] = ((rawTraits.categories ?? []) as any[]).flatMap((cat: any, i: number) => {
    const where = `traits.categories[${i}]`
    if (!checkId(cat?.id, where)) return []
    let max = Infinity
    if (cat?.max !== undefined) {
      max = Number(cat.max)
      if (!Number.isInteger(max) || max < 1) {
        fail(`${where} "${cat.id}": max must be a whole number ≥ 1`)
        return []
      }
    }
    if (cat?.sort !== undefined && cat.sort !== 'alpha') {
      fail(`${where} "${cat.id}": sort must be "alpha" (or omitted)`)
      return []
    }
    return [{ id: cat.id, label: String(cat.label ?? cat.id), max, sortAlpha: cat?.sort === 'alpha' }]
  })
  const categoryIds = new Set(traitCategories.map((cat) => cat.id))

  const traits: Trait[] = ((rawTraits.list ?? []) as any[]).flatMap((t: any, i: number) => {
    const where = `traits.list[${i}]`
    if (!checkId(t?.id, where)) return []
    const category = String(t?.category ?? '')
    if (!categoryIds.has(category)) {
      fail(`${where} "${t.id}": unknown category "${category}" (define it under traits.categories)`)
      return []
    }
    const cost = Number(t?.cost)
    if (!Number.isInteger(cost) || cost < -2 || cost > 2) {
      fail(`${where} "${t.id}": cost must be a whole number from -2 to 2`)
      return []
    }
    const modifiers: TraitModifier[] = ((t?.modifiers ?? []) as any[]).flatMap((m: any, mi: number): TraitModifier[] => {
      const mwhere = `${where}.modifiers[${mi}]`
      const field = fields.get(m?.field)
      const stat = derived.find((d) => d.id === m?.field)
      if (!field && !stat) {
        fail(`${mwhere}: unknown field "${m?.field}" (not an ability, a trained skill, or a derived stat)`)
        return []
      }
      if (stat) {
        const delta = Number(m?.delta)
        if (!Number.isInteger(delta) || delta === 0) {
          fail(`${mwhere}: delta must be a non-zero whole number`)
          return []
        }
        return [{ kind: 'stat_bonus', stat: stat.id, delta } satisfies TraitModifier]
      }
      if (!isBaseField(field!)) {
        fail(`${mwhere}: "${m.field}" can't be modified by a trait (must be an ability, a trained skill, or a derived stat)`)
        return []
      }
      if (field!.trained) {
        const points = Number(m?.skill_points)
        if (!Number.isInteger(points) || points === 0) {
          fail(`${mwhere}: "${m.field}" is a trained skill — give "skill_points" (a non-zero whole number)`)
          return []
        }
        return [{ kind: 'skill_points', field: field!.id, points } satisfies TraitModifier]
      }
      const delta = Number(m?.delta)
      if (!Number.isInteger(delta) || delta === 0) {
        fail(`${mwhere}: delta must be a non-zero whole number`)
        return []
      }
      return [{ kind: 'ability', field: field!.id, delta } satisfies TraitModifier]
    })
    if (!modifiers.length) {
      fail(`${where} "${t.id}": needs at least one modifier`)
      return []
    }
    const description = String(t.description ?? '').trim() || 'MISSING DESCRIPTION'
    const tags = Array.isArray(t?.tags) ? t.tags.map((tag: unknown) => String(tag)) : []
    return [{ id: t.id, label: String(t.label ?? t.id), cost, description, category, tags, modifiers }]
  })

  // challenges: { difficulties: [{id, label, value}], approaches: [{id, label, when}] }
  const rawChallenges = raw?.challenges ?? {}
  const difficulties: Difficulty[] = ((rawChallenges.difficulties ?? []) as any[]).flatMap((d: any, i: number) => {
    const where = `challenges.difficulties[${i}]`
    if (!checkId(d?.id, where)) return []
    const value = Number(d?.value)
    if (!Number.isFinite(value)) {
      fail(`${where} "${d.id}": value must be a number`)
      return []
    }
    return [{ id: d.id, label: String(d.label ?? d.id), value }]
  })
  const approaches: Approach[] = ((rawChallenges.approaches ?? []) as any[]).flatMap((a: any, i: number) => {
    const where = `challenges.approaches[${i}]`
    if (!checkId(a?.id, where)) return []
    const when = String(a?.when ?? 'always') as ApproachWhen
    if (!APPROACH_WHEN.includes(when)) {
      fail(`${where} "${a.id}": when must be one of ${APPROACH_WHEN.join(', ')}`)
      return []
    }
    // effects: [{ face, kind, dice, label }] — what each face of this approach's die does.
    const effects: ApproachEffect[] = ((a?.effects ?? []) as any[]).flatMap((e: any, j: number) => {
      const at = `${where}.effects[${j}]`
      const face = Number(e?.face)
      if (!Number.isFinite(face)) {
        fail(`${at}: face must be a number`)
        return []
      }
      const kind = String(e?.kind ?? 'none') as ApproachEffectKind
      if (!APPROACH_EFFECT_KINDS.includes(kind)) {
        fail(`${at} (face ${face}): kind must be one of ${APPROACH_EFFECT_KINDS.join(', ')}`)
        return []
      }
      const dice = e?.dice === undefined ? 1 : Number(e.dice)
      // lower_raise / match_highest / discard_double are fixed-shape, so they carry no dice count.
      const countsDice = kind === 'extra_dice' || TAP_KINDS.includes(kind)
      if (countsDice && (!Number.isInteger(dice) || dice < 1 || dice > 10)) {
        fail(`${at} (face ${face}): dice must be a whole number 1..10`)
        return []
      }
      const toFace = Number(e?.to_face ?? 0)
      if (kind === 'set_face' && !Number.isFinite(toFace)) {
        fail(`${at} (face ${face}): set_face needs to_face (the face id to set dice to)`)
        return []
      }
      return [{ face, kind, dice, toFace, label: String(e?.label ?? defaultEffectLabel(kind, dice, toFace)) }]
    })
    const duplicate = effects.find((e, j) => effects.findIndex((o) => o.face === e.face) !== j)
    if (duplicate) fail(`${where} "${a.id}": face ${duplicate.face} is listed twice in effects`)
    return [{ id: a.id, label: String(a.label ?? a.id), when, description: String(a.description ?? '').trim(), effects }]
  })
  // challenges.faces: [{ value, label, color }] — names for rolled die faces.
  const faces: FaceName[] = ((rawChallenges.faces ?? []) as any[])
    .flatMap((f: any, i: number) => {
      const where = `challenges.faces[${i}]`
      const value = Number(f?.value)
      if (!Number.isFinite(value)) {
        fail(`${where}: value must be a number`)
        return []
      }
      const look = parseLook(f, where)
      return [{ value, label: String(f?.label ?? value), color: look.color ?? '', ink: look.ink ?? '#ffffff' }]
    })
    .sort((a, b) => a.value - b.value)

  // set_face effects name a face by id, so it has to be one of the faces above.
  if (faces.length) {
    for (const a of approaches) {
      for (const e of a.effects) {
        if (e.kind === 'set_face' && !faces.some((f) => f.value === e.toFace)) {
          fail(`challenges.approaches "${a.id}" (face ${e.face}): to_face ${e.toFace} is not a configured face`)
        }
      }
    }
  }

  // challenges.framing: { ladder: [{ from, difficulty, degrees, label }] } — what the framing
  // roll's margin does to the resolution roll. Each rung covers "from" up to the next rung's
  // "from", and the bottom one catches everything below it, so the bands need not be even.
  const rungs: FramingRung[] = (((rawChallenges.framing ?? {}).ladder ?? []) as any[])
    .flatMap((r: any, i: number) => {
      const where = `challenges.framing.ladder[${i}]`
      const from = Number(r?.from)
      if (!Number.isInteger(from)) {
        fail(`${where}: from must be a whole number (the lowest margin this rung covers)`)
        return []
      }
      const difficulty = Number(r?.difficulty ?? 0)
      const degrees = Number(r?.degrees ?? 0)
      if (!Number.isInteger(difficulty)) fail(`${where} (from ${from}): difficulty must be a whole number`)
      if (!Number.isInteger(degrees)) fail(`${where} (from ${from}): degrees must be a whole number`)
      return [{ from, difficulty, degrees, label: String(r?.label ?? '') }]
    })
    .sort((a, b) => a.from - b.from)
  const duplicateRung = rungs.find((r, i) => i > 0 && r.from === rungs[i - 1]!.from)
  if (duplicateRung) fail(`challenges.framing.ladder: two rungs start at ${duplicateRung.from}`)

  // challenges.exertion_sources: [stamina, willpower] — must be pool stats (spend 1, gain exertion).
  const exertionSources: string[] = ((rawChallenges.exertion_sources ?? []) as any[]).flatMap((id: any, i: number) => {
    const statId = String(id)
    const stat = derived.find((d) => d.id === statId)
    if (!stat) fail(`challenges.exertion_sources[${i}]: no derived value "${statId}"`)
    else if (!stat.pool) fail(`challenges.exertion_sources[${i}]: "${statId}" must be a pool (pool: true)`)
    else return [statId]
    return []
  })

  const sortedValues = difficulties.map((d) => d.value).sort((a, b) => a - b)
  const gaps = sortedValues.slice(1).map((v, i) => v - sortedValues[i]!)
  const rankStep = gaps.length ? Math.round(gaps.reduce((a, b) => a + b, 0) / gaps.length) : 3

  if (errors.length) {
    throw new Error(`Problems in ${path}:\n  - ${errors.join('\n  - ')}`)
  }
  return {
    name: String(raw?.name ?? 'Untitled system'),
    sections,
    derived,
    rolls,
    fields,
    training,
    level: levelItem,
    traits,
    traitCategories,
    powerLevel,
    challenges: {
      difficulties,
      approaches,
      framing: { rungs },
      faces,
      exertionSources,
      rankStep,
    },
  }
}

/** WCAG relative luminance of a 6-digit hex colour (0 = black, 1 = white). */
function luminance(hex: string) {
  const [r, g, b] = [0, 2, 4].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!
}

/** Strips XML prolog, doctype and comments so downloaded SVGs can be inlined. */
function cleanSvg(svg: string) {
  return svg
    .replace(/<\?xml[\s\S]*?\?>/g, '')
    .replace(/<!DOCTYPE[\s\S]*?>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .trim()
}
