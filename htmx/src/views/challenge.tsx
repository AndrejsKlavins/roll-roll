// Public challenge board: big main/supporting difficulty numbers, the joined player's roll,
// and a history log of past challenges. Shared between /table (the shared screen), /gm (setup +
// oversight) and the player's own page (join/roll controls) — role picks what's interactive.
import { raw } from 'hono/html'
import { abilityRankRange } from '../rules'
import type { ApproachEffect, ApproachWhen, FaceName, Icon, NumberField } from '../rules'
import type { Child } from 'hono/jsx'
import {
  APPROACH_DIE_SIDES,
  challengeTarget,
  isBaseField,
  MAX_CIRCUMSTANCE,
  type Contestant,
  type Opposition,
  type OppositionSide,
  type SoloRoll,
  type Challenge,
  type ChallengeSide,
  type DieMarker,
  type Session,
  type SideOutcome,
} from '../session'

const oobAttr = (oob?: boolean) => (oob ? 'true' : undefined)
const signed = (n: number) => (n === 0 ? '0' : n > 0 ? `+${n}` : String(n))
const stakesLabel = (s: string) => s[0]!.toUpperCase() + s.slice(1)

function degreeText(outcome: SideOutcome, stakes: string) {
  if (stakes === 'low' || outcome.degrees === 0) return null
  const n = Math.abs(outcome.degrees)
  const word = outcome.degrees > 0 ? 'boon' : 'complication'
  return `${n} ${word}${n > 1 ? 's' : ''}`
}

/** The name/colour of a die face id (1–6). Ids outside the configured list clamp to its ends. */
function faceName(faces: FaceName[], faceId: number | undefined): FaceName | null {
  if (faces.length === 0 || faceId === undefined) return null
  return faces.find((f) => f.value === faceId) ?? (faceId < faces[0]!.value ? faces[0]! : faces.at(-1)!)
}

/**
 * One rolled die: the square shows the shifted value that counts in the check, the name below
 * comes from the raw face id, so "poor" on a strong character can still beat "good" on a weak one.
 */
function Die(props: {
  value: number
  faceId?: number
  faces: FaceName[]
  discarded?: boolean
  /** How many times this die has been rolled again; shown under it. */
  rerolled?: number
  /** Set when an approach effect moved this die's face; named under it. */
  changed?: DieMarker
  action?: DieAction
}) {
  const face = faceName(props.faces, props.faceId)
  const style = face?.color ? `--face-color: ${face.color}` : undefined
  const inner = (
    <>
      <span class="die-face">{props.value}</span>
      {face && <span class="die-name">{face.label}</span>}
      {!!props.rerolled && <span class="die-rerolls">Reroll {props.rerolled}</span>}
      {props.changed && (
        <span class={`die-changed die-changed-${props.changed}`}>{markerLabel(props.changed)}</span>
      )}
    </>
  )
  const cls = ['die', props.discarded && 'die-discarded'].filter(Boolean).join(' ')
  // While something can be done to a die (exertion reroll, a pending approach effect) the die
  // itself is the button.
  if (props.action) {
    return (
      <button
        type="button"
        class={`${cls} die-tappable die-${props.action.kind}`}
        style={style}
        hx-post={props.action.url}
        hx-swap="none"
        title={props.action.title}
      >
        {inner}
      </button>
    )
  }
  return (
    <span class={cls} style={style}>
      {inner}
    </span>
  )
}

/** What tapping a die does right now. `kind` only picks the highlight colour. */
type DieAction = { kind: 'reroll' | 'discard' | 'face-change'; url: string; title: string }

/** What an approach effect did to a die, named under it. */
const markerLabel = (marker: NonNullable<DieMarker>) =>
  marker === 'raised'
    ? 'Raised'
    : marker === 'lowered'
      ? 'Lowered'
      : marker === 'matched'
        ? 'Matched'
        : marker === 'copied'
          ? 'Copy'
          : 'Squashed'

/** One side's big number: target, then (once rolled) dice, skill bonus, final sum and difference. */
function DifficultyBox(props: {
  field: NumberField | undefined
  label: string
  /** The number to beat, circumstance already applied (see challengeTarget). */
  target: number
  /** The GM's difficulty before the circumstance came off it — named by `tier`. */
  baseTarget: number
  /** The circumstance modifier itself; shown to everyone when it is not 0. */
  circumstance: number
  /** The GM's − / + buttons, when the viewer is the GM. */
  circumstanceControls?: Child
  tier: string | null
  side: ChallengeSide | null
  skillPoints: number
  outcome: SideOutcome | null
  stakes: string
  faces: FaceName[]
  exertion: number
  /** Set when the viewer may act on the dice here (exertion reroll, pending approach effect). */
  dieAction?: (index: number) => DieAction | undefined
  /** GM and table screens name the result; the player sees their own controls instead. */
  attemptLabel?: boolean
  controls?: Child
}) {
  const { field, label, target, tier, side, skillPoints, outcome, stakes } = props
  const cls = ['difficulty-box', outcome && (outcome.success ? 'success' : 'failure')].filter(Boolean).join(' ')
  return (
    <div class={cls} style={field?.color ? `--field-color: ${field.color}; --field-ink: ${field.ink}` : undefined}>
      <div class="difficulty-label">
        <IconChip icon={field?.icon} />
        <span>{label}</span>
      </div>
      <div class="difficulty-target">
        {target}
        {tier && <span class="difficulty-tier">({tier})</span>}
        {props.circumstance !== 0 && (
          <span
            class={props.circumstance > 0 ? 'circumstance hinder' : 'circumstance help'}
            title={`Circumstance ${signed(props.circumstance)} — difficulty ${props.baseTarget} ${
              props.circumstance > 0 ? 'raised to' : 'lowered to'
            } ${target}`}
          >
            {signed(props.circumstance)}
          </span>
        )}
      </div>
      {props.circumstanceControls}
      {side && outcome && (
        <div class="difficulty-result">
          {props.attemptLabel && <div class="attempt-label">Player attempt</div>}
          <div class="dice-faces">
            {side.dice.map((d, i) => (
              <Die
                value={d}
                faceId={side.faces?.[i]}
                faces={props.faces}
                discarded={side.discarded?.[i]}
                rerolled={side.rerolled?.[i]}
                changed={side.changed?.[i]}
                action={side.discarded?.[i] ? undefined : props.dieAction?.(i)}
              />
            ))}
            {skillPoints !== 0 && <span class="skill-bonus">{signed(skillPoints)}</span>}
            {props.exertion !== 0 && <span class="exert-bonus">{signed(props.exertion)}</span>}
          </div>
          <div class="difficulty-sum">{outcome.sum}</div>
          <div class="difficulty-diff">{signed(outcome.difference)}</div>
          {degreeText(outcome, stakes) && <div class="difficulty-degree">{degreeText(outcome, stakes)}</div>}
          {props.controls}
        </div>
      )}
    </div>
  )
}

/**
 * GM only: nudges one side's circumstance modifier. It is added to the difficulty, so a plus makes
 * the check harder and a minus makes it easier. Offered from the moment the challenge exists until
 * it is closed — a ruling can land before the roll or part-way through it — and every screen shows
 * the result. The legend sits above the buttons so the row stays narrow enough for the GM column.
 */
function CircumstanceControls(props: { side: 'main' | 'support'; value: number }) {
  const { side, value } = props
  const step = (delta: number, label: string, disabled: boolean) => (
    <button
      type="button"
      class="circumstance-step"
      hx-post={`/gm/challenge/circumstance?side=${side}&delta=${delta}`}
      hx-swap="none"
      disabled={disabled || undefined}
      title={delta > 0 ? 'Circumstance against the player' : 'Circumstance in the player\u2019s favour'}
    >
      {label}
    </button>
  )
  return (
    <div class="circumstance-set">
      <span class="circumstance-legend">Circumstance</span>
      <div class="circumstance-controls">
        {step(-1, '\u2212', value <= -MAX_CIRCUMSTANCE)}
        <output>{signed(value)}</output>
        {step(1, '+', value >= MAX_CIRCUMSTANCE)}
      </div>
    </div>
  )
}

/** When an approach's die counts, in the player's words. */
const whenHint = (when: ApproachWhen) =>
  when === 'always' ? 'always counts' : when === 'failure' ? 'only when failing' : 'your choice'

/**
 * Approach + skill pick, then Roll — shown to the joined player before rolling. One stacked
 * button per approach, its description to the left; picking posts straight away (the pick lives
 * on the challenge, so the board comes back with the chosen one marked).
 */
function ChallengeSetupControls(props: { session: Session; ch: Challenge; charId: string }) {
  const { session, ch, charId } = props
  const { rules } = session
  const skills = [...rules.fields.values()].filter((f): f is NumberField => f.type === 'number' && f.trained)
  return (
    <div class="challenge-player-setup">
      <div class="approach-pick">
        <span class="approach-legend">Approach</span>
        {rules.challenges.approaches.map((a) => (
          <div class="approach-row">
            <p class="approach-desc">{a.description || whenHint(a.when)}</p>
            <button
              type="button"
              class={ch.approach === a.id ? 'approach-btn on' : 'approach-btn'}
              hx-post={`/c/${charId}/challenge/setup`}
              hx-vals={JSON.stringify({ approach: a.id })}
              hx-swap="none"
            >
              {a.label}
            </button>
          </div>
        ))}
      </div>
      <label class="skill-pick">
        Skill boost
        <select name="skill" hx-post={`/c/${charId}/challenge/setup`} hx-trigger="change" hx-swap="none">
          <option value="">None</option>
          {skills.map((f) => (
            <option value={f.id} selected={ch.skill === f.id || undefined}>
              {f.label}
            </option>
          ))}
        </select>
      </label>
      <button type="button" class="primary" hx-post={`/c/${charId}/challenge/roll`} hx-swap="none" disabled={!ch.approach || undefined}>
        Roll
      </button>
    </div>
  )
}

/**
 * The approach die: one plain d6 rolled with the ability dice. When it counts follows the
 * approach's `when` (always / only while failing / the player's choice); what it does on that
 * face comes from `effects` in rules.yaml. Effects that need a target put the board in a pending
 * state — the dice become tappable, or the two abilities appear here for extra dice.
 */
function ApproachDie(props: {
  session: Session
  ch: Challenge
  /** The viewer is the rolling player and the challenge is still open. */
  acting: boolean
  /** GM debug tool: offer a button per face, forcing the die onto it. */
  debug?: boolean
  charId?: string
  abilities: { side: 'main' | 'support'; label: string; field: NumberField | undefined }[]
}) {
  const { session, ch, acting } = props
  const state = session.approachState(ch)
  if (!state) return null
  const { effect } = state
  // "Challenge done" ends the pick too: an effect nobody applied in time simply went unused.
  const pending = state.pending && !!effect && !ch.closed
  // What this face is (the effect's own words, or a plain note for an approach with no effects).
  const note = effect
    ? effect.label
    : state.status === 'active'
      ? ch.approachActivated
        ? 'Activated'
        : state.approach.when === 'failure'
          ? 'In effect — the roll is failing'
          : 'In effect'
      : state.status === 'skipped'
        ? 'Skipped — the roll succeeded'
        : 'Not activated'
  // Tweak only offers dice that have somewhere to go, so it can run out of targets (every die at
  // the worst face while lowering, say). Saying so beats prompting for a tap nothing can satisfy.
  const stuck = pending && effect!.kind === 'lower_raise' && !session.anyTweakableDie(ch)
  // Where it stands: waiting for picks, applied, or left unused when the GM closed the challenge.
  const status = !effect
    ? null
    : stuck
      ? state.step === 'first'
        ? 'No die can be lowered — every one is at its worst face'
        : 'No die can be raised — every one is at its best face'
      : pending
        ? pickPrompt(effect, state.picksLeft, acting, state.step)
        : state.pending
          ? 'Not used'
          : ch.approachActivated
            ? effect.kind === 'declare'
              ? 'In effect'
              : 'Done'
            : state.status === 'skipped'
              ? 'Skipped — the roll succeeded'
              : null
  const cls = ['approach-die', `approach-${state.status}`, pending && 'approach-pending'].filter(Boolean).join(' ')
  return (
    <div class={cls}>
      <div class="approach-label">{state.approach.label}</div>
      <span class="die">
        <span class="die-face">{state.die}</span>
      </span>
      <div class="approach-note">{note}</div>
      {status && <div class="approach-status">{status}</div>}
      {acting && state.canActivate && (
        <button
          type="button"
          class="approach-activate"
          hx-post={`/c/${props.charId}/challenge/activate-approach`}
          hx-swap="none"
        >
          Activate result
        </button>
      )}
      {/* Two effects have no die to tap — the player picks an ability here instead: extra dice
          (rolled for that ability) and Perfect balance (its lowest die rises to its highest). */}
      {acting && pending && abilityPick(effect!.kind) && (
        <div class="approach-sides">
          {props.abilities.map((a) => (
            <button
              type="button"
              class="approach-side-btn"
              style={a.field?.color ? `--field-color: ${a.field.color}; --field-ink: ${a.field.ink}` : undefined}
              hx-post={`/c/${props.charId}/challenge/approach-pick?side=${a.side}${
                effect!.kind === 'match_highest' ? '&effect=match' : ''
              }`}
              hx-swap="none"
            >
              <IconChip icon={a.field?.icon} />
              <span class="label">{a.label}</span>
            </button>
          ))}
        </div>
      )}
      {props.debug && <ApproachDieDebug approach={state.approach} die={state.die} />}
    </div>
  )
}

/**
 * Debug tool, GM screen only: force the approach die onto any face to try that face's effect
 * without rolling for it. The player's Activate comes back for the new face; anything an earlier
 * activation already did to the ability dice stays.
 */
function ApproachDieDebug(props: { approach: { effects: ApproachEffect[] }; die: number }) {
  const faces = Array.from({ length: APPROACH_DIE_SIDES }, (_, i) => i + 1)
  return (
    <div class="approach-debug">
      <span class="approach-debug-legend">Debug: set face</span>
      <div class="approach-debug-faces">
        {faces.map((face) => {
          const effect = props.approach.effects.find((e) => e.face === face) ?? null
          const title = effect?.label || (effect ? effect.kind : 'no effect on this face')
          return (
            <button
              type="button"
              class={face === props.die ? 'approach-debug-btn on' : 'approach-debug-btn'}
              title={`Face ${face} — ${title}`}
              hx-post={`/gm/challenge/approach-die?face=${face}`}
              hx-swap="none"
            >
              {face}
            </button>
          )
        })}
      </div>
    </div>
  )
}

/** Effects whose pick is one of the two abilities rather than a die on the board. */
const abilityPick = (kind: ApproachEffect['kind']) => kind === 'extra_dice' || kind === 'match_highest'

/**
 * What the player (or everyone else, watching) is told to do while an effect waits for a pick.
 * Effects over several dice count down, so the prompt always says how many are still to come;
 * two-step effects (Tweak, Perfect choice) name the step they are on instead.
 */
function pickPrompt(effect: ApproachEffect, picksLeft: number, acting: boolean, step: 'first' | 'second') {
  const who = acting ? 'Tap' : 'Player taps'
  const dice = picksLeft === 1 ? 'a die' : `${picksLeft} dice`
  const them = picksLeft === 1 ? 'it' : 'them'
  if (effect.kind === 'discard') return `${who} ${dice} to discard ${them}`
  if (effect.kind === 'reroll') return `${who} ${dice} to reroll ${them}`
  if (effect.kind === 'raise_face') return `${who} ${dice} to raise ${them} one face`
  if (effect.kind === 'set_face') return `${who} ${dice} to set ${them} to face ${effect.toFace}`
  if (effect.kind === 'lower_raise') {
    return step === 'first' ? `${who} a die to lower it one face` : `${who} another die to raise it one face`
  }
  if (effect.kind === 'discard_double') {
    return step === 'first'
      ? `${who} a die to discard it`
      : `${who} a die on the other ability to copy it`
  }
  if (effect.kind === 'match_highest') {
    const what = "whose lowest die rises to its highest"
    return acting ? `Pick the ability ${what}` : `Player picks the ability ${what}`
  }
  const n = effect.dice === 1 ? 'one extra die' : `${effect.dice} extra dice`
  return acting ? `Pick the ability to roll ${n} for` : `Player picks the ability for ${n}`
}

/** Skill bonus left to spend on the two sides (the declared skill's rank, minus what is spent). */
function skillBonusState(session: Session, ch: Challenge) {
  const char = ch.charId ? session.characters.get(ch.charId) : null
  const skillField = ch.skill ? (session.rules.fields.get(ch.skill) as NumberField | undefined) : undefined
  if (!char || !skillField) return null
  const rank = Math.round(Number(session.baseOf(char, skillField)))
  return { label: skillField.label, rank, left: rank - ch.mainSkillPoints - ch.supportSkillPoints }
}

/**
 * Exertion: burn a point of a pool stat (stamina/willpower) for one exertion, then spend it as
 * +1 on a side or to reroll a die. Shown to the rolling player while the challenge is open.
 */
function ExertionControls(props: { session: Session; ch: Challenge; charId: string }) {
  const { session, ch, charId } = props
  const char = session.characters.get(charId)!
  const available = session.availableExertion(ch)
  const sources = session.rules.challenges.exertionSources.flatMap((statId) => {
    const stat = session.rules.derived.find((d) => d.id === statId)
    const value = session.statOf(char, statId)
    return stat && value ? [{ stat, left: value.current }] : []
  })
  if (sources.length === 0) return null
  return (
    <div class="exertion">
      <p class="exertion-left">
        Exertion: <b>{available}</b>
        {available > 0 && <span class="muted"> — add it to a result or tap a die to reroll</span>}
      </p>
      <div class="exert-buttons">
        {sources.map(({ stat, left }) => (
          <button
            type="button"
            class="exert-btn"
            style={stat.color ? `--field-color: ${stat.color}; --field-ink: ${stat.ink}` : undefined}
            hx-post={`/c/${charId}/challenge/exert`}
            hx-vals={JSON.stringify({ stat: stat.id })}
            hx-swap="none"
            disabled={left <= 0 || undefined}
          >
            <IconChip icon={stat.icon} />
            <span class="label">Exert your {stat.label.toLowerCase()}</span>
            <span class="exert-left">{left}</span>
          </button>
        ))}
      </div>
    </div>
  )
}

/** − / + for one side's skill bonus: spends from the shared pool, never below what it holds. */
function SkillBonusControls(props: { ch: Challenge; charId: string; side: 'main' | 'support'; left: number }) {
  const { ch, charId, side, left } = props
  const points = side === 'main' ? ch.mainSkillPoints : ch.supportSkillPoints
  const vals = (delta: number) => {
    const next = { main: ch.mainSkillPoints, support: ch.supportSkillPoints }
    next[side] += delta
    return JSON.stringify(next)
  }
  return (
    <div class="skill-alloc">
      <button
        type="button"
        hx-post={`/c/${charId}/challenge/skill-points`}
        hx-vals={vals(-1)}
        hx-swap="none"
        disabled={points <= 0 || undefined}
        aria-label="Remove skill bonus"
      >
        −
      </button>
      <span class="skill-alloc-value">{signed(points)}</span>
      <button
        type="button"
        hx-post={`/c/${charId}/challenge/skill-points`}
        hx-vals={vals(1)}
        hx-swap="none"
        disabled={left <= 0 || undefined}
        aria-label="Add skill bonus"
      >
        +
      </button>
    </div>
  )
}

/** The joined player's own ability values for the two sides in play. */
function ChallengeAbilities(props: { session: Session; ch: Challenge }) {
  const { session, ch } = props
  const char = ch.charId ? session.characters.get(ch.charId) : null
  if (!char) return null
  const mainField = session.rules.fields.get(ch.mainAbility) as NumberField
  const supportField = session.rules.fields.get(ch.supportAbility) as NumberField
  return (
    <div class="challenge-abilities">
      <span class="challenge-player-name">{char.name}</span>
      <span>
        {mainField.label} {session.valueOf(char, mainField)}
      </span>
      <span>
        {supportField.label} {session.valueOf(char, supportField)}
      </span>
    </div>
  )
}

/** Full board for the current (last-started) challenge. Interactive parts only for role "player". */
function CurrentChallenge(props: { session: Session; ch: Challenge; role: 'gm' | 'player' | 'table'; viewerCharId?: string }) {
  const { session, ch, role, viewerCharId } = props
  const mainField = session.rules.fields.get(ch.mainAbility) as NumberField | undefined
  const supportField = session.rules.fields.get(ch.supportAbility) as NumberField | undefined
  const outcome = session.challengeOutcome(ch)
  // Challenges store the number; name the tier it came from when one matches exactly.
  const tierOf = (value: number) =>
    session.rules.challenges.difficulties.find((d) => d.value === value)?.label ?? null
  const isViewerTurn = role === 'player' && !!viewerCharId && ch.charId === viewerCharId
  const bonus = skillBonusState(session, ch)
  // Only the player who rolled acts on it, and only after the dice are in, until the GM closes it.
  const acting = isViewerTurn && !!ch.main && !ch.closed
  const allocating = acting && !!ch.skill && !!bonus
  const exertion = session.availableExertion(ch)
  const sideControls = (side: 'main' | 'support') => {
    if (!acting) return undefined
    return (
      <>
        {allocating && <SkillBonusControls ch={ch} charId={viewerCharId!} side={side} left={bonus!.left} />}
        <button
          type="button"
          class="exert-spend"
          hx-post={`/c/${viewerCharId}/challenge/spend-exertion`}
          hx-vals={JSON.stringify({ side })}
          hx-swap="none"
          disabled={exertion <= 0 || undefined}
        >
          + exertion
        </button>
      </>
    )
  }
  // A pending approach effect owns the dice while it lasts (it is the step the board is waiting
  // on); otherwise they are exertion reroll buttons whenever exertion is in hand.
  const approach = session.approachState(ch)
  const pendingKind = acting && approach?.pending ? approach.effect?.kind : undefined
  // Multi-die effects never take the same die twice, so dice already used drop out.
  const picked = (side: 'main' | 'support', index: number) => ch.approachPicked.includes(`${side}:${index}`)
  const dieAction = (side: 'main' | 'support') => {
    const tap = (kind: DieAction['kind'], effect: string, title: string) => (index: number) =>
      picked(side, index)
        ? undefined
        : {
            kind,
            url: `/c/${viewerCharId}/challenge/approach-pick?effect=${effect}&side=${side}&index=${index}`,
            title: `${title} (${approach!.approach.label})`,
          }
    if (pendingKind === 'discard') return tap('discard', 'discard', 'Discard this die')
    if (pendingKind === 'reroll') return tap('reroll', 'reroll', 'Reroll this die')
    if (pendingKind === 'raise_face') return tap('face-change', 'face', 'Raise this die one face')
    if (pendingKind === 'set_face') {
      return tap('face-change', 'face', `Set this die to face ${approach!.effect!.toFace}`)
    }
    // Tweak: the first tap lowers a die, the second raises another. A die already on the worst
    // face (lowering) or the best one (raising) has nowhere to go, so it is not offered at all.
    if (pendingKind === 'lower_raise') {
      const lowering = approach!.step === 'first'
      const tapper = tap('face-change', 'face', lowering ? 'Lower this die one face' : 'Raise this die one face')
      return (index: number) => (session.tweakableDie(ch, side, index) ? tapper(index) : undefined)
    }
    // Perfect choice: discard on one ability, then copy a die on the other — so once the discard
    // is made, that side's dice stop being buttons.
    if (pendingKind === 'discard_double') {
      if (approach!.step === 'first') return tap('discard', 'discard', 'Discard this die')
      return approach!.firstPickSide === side ? undefined : tap('face-change', 'copy', 'Copy this die')
    }
    if (!acting || approach?.pending || exertion <= 0) return undefined
    return (index: number): DieAction => ({
      kind: 'reroll',
      url: `/c/${viewerCharId}/challenge/reroll?side=${side}&index=${index}`,
      title: 'Reroll with exertion',
    })
  }
  const abilities = [
    { side: 'main' as const, label: mainField?.label ?? ch.mainAbility, field: mainField },
    { side: 'support' as const, label: supportField?.label ?? ch.supportAbility, field: supportField },
  ]
  return (
    <div class="challenge">
      {ch.description && <h3 class="challenge-description">{ch.description}</h3>}
      <div class="challenge-head">
        <span class={`stakes stakes-${ch.stakes}`}>{stakesLabel(ch.stakes)} stakes</span>
        {outcome && <span class={outcome.success ? 'result success' : 'result failure'}>{outcome.success ? 'Success' : 'Failure'}</span>}
        {ch.closed && <span class="badge closed">Done</span>}
      </div>
      <div class="challenge-numbers">
        <DifficultyBox
          field={mainField}
          label={mainField?.label ?? ch.mainAbility}
          target={challengeTarget(ch, 'main')}
          baseTarget={ch.mainDifficulty}
          circumstance={ch.mainCircumstance}
          circumstanceControls={
            role === 'gm' && !ch.closed ? <CircumstanceControls side="main" value={ch.mainCircumstance} /> : undefined
          }
          tier={tierOf(ch.mainDifficulty)}
          side={ch.main}
          skillPoints={ch.mainSkillPoints}
          outcome={outcome?.main ?? null}
          stakes={ch.stakes}
          faces={session.rules.challenges.faces}
          exertion={ch.exertionMain}
          dieAction={dieAction('main')}
          attemptLabel={role !== 'player'}
          controls={sideControls('main')}
        />
        <DifficultyBox
          field={supportField}
          label={supportField?.label ?? ch.supportAbility}
          target={challengeTarget(ch, 'support')}
          baseTarget={ch.supportDifficulty}
          circumstance={ch.supportCircumstance}
          circumstanceControls={
            role === 'gm' && !ch.closed ? (
              <CircumstanceControls side="support" value={ch.supportCircumstance} />
            ) : undefined
          }
          tier={tierOf(ch.supportDifficulty)}
          side={ch.support}
          skillPoints={ch.supportSkillPoints}
          outcome={outcome?.support ?? null}
          stakes={ch.stakes}
          faces={session.rules.challenges.faces}
          exertion={ch.exertionSupport}
          dieAction={dieAction('support')}
          attemptLabel={role !== 'player'}
          controls={sideControls('support')}
        />
      </div>
      <ApproachDie
        session={session}
        ch={ch}
        acting={acting}
        debug={role === 'gm' && !!ch.main && !ch.closed}
        charId={viewerCharId}
        abilities={abilities}
      />
      {role !== 'player' && <ChallengeAbilities session={session} ch={ch} />}
      {isViewerTurn && !ch.main && (
        <ChallengeSetupControls session={session} ch={ch} charId={viewerCharId!} />
      )}
      {allocating && (
        <p class="skill-bonus-left">
          {bonus!.label} bonus: <b>{bonus!.left}</b> left of {bonus!.rank}
        </p>
      )}
      {acting && <ExertionControls session={session} ch={ch} charId={viewerCharId!} />}
      {role === 'gm' && ch.main && !ch.closed && (
        <button type="button" class="primary" hx-post="/gm/challenge/done" hx-swap="none">
          Challenge done
        </button>
      )}
    </div>
  )
}

/** Past challenges (everything except the current one), most recent first. */
function ChallengeLog(props: { session: Session; entries: Challenge[] }) {
  const { session, entries } = props
  if (entries.length === 0) return null
  return (
    <ul class="challenge-log">
      {entries.map((ch) => {
        const outcome = session.challengeOutcome(ch)
        const mainField = session.rules.fields.get(ch.mainAbility)
        const supportField = session.rules.fields.get(ch.supportAbility)
        const char = ch.charId ? session.characters.get(ch.charId) : null
        return (
          <li class={outcome ? (outcome.success ? 'success' : 'failure') : undefined}>
            <span class="challenge-log-what">{ch.description || '—'}</span>
            <span class="challenge-log-who">{char?.name ?? 'Nobody joined'}</span>
            <span class="challenge-log-numbers">
              {mainField?.label} {challengeTarget(ch, 'main')} / {supportField?.label}{' '}
              {challengeTarget(ch, 'support')} · {stakesLabel(ch.stakes)}
              {(ch.mainCircumstance !== 0 || ch.supportCircumstance !== 0) && ' · circumstance'}
            </span>
            {outcome && <span class="challenge-log-result">{outcome.success ? 'Success' : 'Failure'}</span>}
          </li>
        )
      })}
    </ul>
  )
}

function IconChip(props: { icon?: Icon }) {
  const { icon } = props
  if (!icon) return null
  return (
    <span class="field-icon" aria-hidden="true">
      {icon.kind === 'svg' ? raw(icon.markup) : icon.kind === 'img' ? <img src={icon.src} alt="" /> : icon.text}
    </span>
  )
}

/**
 * One side of the setup dialog: a big indicator of what is picked, an ability column and a
 * difficulty column. All picking is Alpine state on the form (vars named by `ability`/`diff`).
 */
function SidePicker(props: {
  title: string
  abilityVar: string
  diffVar: string
  diffValueVar: string
  abilities: NumberField[]
  difficulties: { id: string; label: string; value: number }[]
}) {
  const { title, abilityVar, diffVar, diffValueVar, abilities, difficulties } = props
  const picked = `(abilities.find((a) => a.id === ${abilityVar}) || {})`
  return (
    <section class="side-pick">
      <h4>{title}</h4>
      <div class="big-indicator">
        <span class="bi-ability" x-text={`${picked}.label || 'Pick an ability'`} x-bind:style={`${picked}.color && 'color: ' + ${picked}.color`}>
          Pick an ability
        </span>
        {/* The number takes the ability's colour and is preceded by that ability's icon. Every
            icon is rendered and only the picked one is shown, so no SVG is needed client-side. */}
        <span class="bi-value" x-bind:style={`${picked}.color && 'color: ' + ${picked}.color`}>
          {abilities.map((f) => (
            <span
              class="bi-icon"
              x-cloak
              x-show={`${abilityVar} === '${f.id}'`}
              style={f.color ? `--field-color: ${f.color}; --field-ink: ${f.ink}` : undefined}
            >
              <IconChip icon={f.icon} />
            </span>
          ))}
          <span x-text={`${diffValueVar} === '' ? '–' : ${diffValueVar}`}>–</span>
          <span
            class="bi-tier"
            x-cloak
            x-show={diffVar}
            x-text={`'(' + ((difficulties.find((d) => d.id === ${diffVar}) || {}).label || '') + ')'`}
          ></span>
        </span>
      </div>
      <div class="pick-columns">
        <div class="pick-col">
          {abilities.map((f) => (
            <button
              type="button"
              class="pick-btn ability-btn"
              style={f.color ? `--field-color: ${f.color}; --field-ink: ${f.ink}` : undefined}
              x-bind:class={`{ on: ${abilityVar} === '${f.id}' }`}
              x-on:click={`${abilityVar} = '${f.id}'`}
            >
              <IconChip icon={f.icon} />
              <span class="label">{f.label}</span>
            </button>
          ))}
        </div>
        <div class="pick-col">
          {difficulties.map((d) => (
            <button
              type="button"
              class="pick-btn diff-btn"
              x-bind:class={`{ on: ${diffVar} === '${d.id}' }`}
              x-on:click={`${diffVar} = '${d.id}'; ${diffValueVar} = ${d.value}`}
            >
              <span class="label">{d.label}</span>
              <span class="diff-value">{d.value}</span>
            </button>
          ))}
        </div>
      </div>
    </section>
  )
}

/** Clears the dialog's picks (Alpine state) after a challenge is started, then closes it. */
const AFTER_START = [
  'if (!event.detail.successful) return;',
  'const d = Alpine.$data(this);',
  "Object.assign(d, { description: '', stakes: 'normal', mainAbility: '', mainDiff: '', mainValue: '',",
  "  supportAbility: '', supportDiff: '', supportValue: '', charId: '' });",
  "this.closest('dialog').close()",
].join(' ')

/** Characters the GM can put on a challenge. Swapped on its own when the cast changes. */
export function ChallengePlayerPicker(props: { session: Session; oob?: boolean }) {
  const characters = [...props.session.characters.values()].filter((c) => c.status === 'active')
  return (
    <div id="challenge-players" class="pick-col" hx-swap-oob={oobAttr(props.oob)}>
      {characters.length === 0 ? (
        <p class="muted">No finished characters yet.</p>
      ) : (
        characters.map((c) => (
          <button
            type="button"
            class="pick-btn"
            x-bind:class={`{ on: charId === '${c.id}' }`}
            x-on:click={`charId = '${c.id}'`}
          >
            <span class="label">{c.name}</span>
          </button>
        ))
      )}
    </div>
  )
}

/**
 * GM-only dialog holding the whole challenge setup. Lives outside the board so live board
 * updates (a player rolling) can't close it mid-edit.
 */
export function ChallengeSetupDialog(props: { session: Session }) {
  const { session } = props
  const { rules } = session
  const abilities = [...rules.fields.values()].filter((f): f is NumberField => isBaseField(f) && !f.trained)
  const difficulties = rules.challenges.difficulties
  const state = {
    description: '',
    stakes: 'normal',
    mainAbility: '',
    mainDiff: '',
    mainValue: '',
    supportAbility: '',
    supportDiff: '',
    supportValue: '',
    charId: '',
    abilities: abilities.map((f) => ({ id: f.id, label: f.label, color: f.color ?? '' })),
    difficulties: difficulties.map((d) => ({ id: d.id, label: d.label, value: d.value })),
  }
  return (
    <dialog id="challenge-dialog" class="challenge-dialog">
      <form
        hx-post="/gm/challenge/start"
        hx-swap="none"
        x-data={JSON.stringify(state)}
        hx-on--after-request={AFTER_START}
      >
        <header class="dialog-head">
          <h3>New challenge</h3>
          <button type="button" class="small" x-on:click="$el.closest('dialog').close()">
            Close
          </button>
        </header>

        <label class="challenge-description-field">
          <span>What is the challenge?</span>
          <input
            name="description"
            x-model="description"
            placeholder="e.g. Climb the cliff before the tide turns"
            maxlength={200}
            autocomplete="off"
            required
          />
        </label>

        <div class="stakes-row">
          {(['low', 'normal', 'high'] as const).map((s) => (
            <button
              type="button"
              class={`stakes-btn stakes-${s}`}
              x-bind:class={`{ on: stakes === '${s}' }`}
              x-on:click={`stakes = '${s}'`}
            >
              {stakesLabel(s)}
            </button>
          ))}
        </div>

        <SidePicker
          title="Main ability"
          abilityVar="mainAbility"
          diffVar="mainDiff"
          diffValueVar="mainValue"
          abilities={abilities}
          difficulties={difficulties}
        />
        <SidePicker
          title="Supporting ability"
          abilityVar="supportAbility"
          diffVar="supportDiff"
          diffValueVar="supportValue"
          abilities={abilities}
          difficulties={difficulties}
        />

        <section class="side-pick player-pick">
          <h4>Who rolls</h4>
          <ChallengePlayerPicker session={session} />
        </section>

        <input type="hidden" name="stakes" x-model="stakes" />
        <input type="hidden" name="main_ability" x-model="mainAbility" />
        <input type="hidden" name="main_difficulty" x-model="mainValue" />
        <input type="hidden" name="support_ability" x-model="supportAbility" />
        <input type="hidden" name="support_difficulty" x-model="supportValue" />
        <input type="hidden" name="char_id" x-model="charId" />
        <button
          type="submit"
          class="primary"
          x-bind:disabled="!(description.trim() && mainAbility && mainDiff && supportAbility && supportDiff && charId)"
        >
          Start challenge
        </button>
      </form>
    </dialog>
  )
}

/**
 * The GM's solo roll: the opposition number it went against, the two dice, the total and whether
 * it beat the number. Shown on the GM board always, and on the player/table screens only once the
 * GM has made it public — so a hidden check stays hidden.
 */
function SoloRollCard(props: { session: Session; solo: SoloRoll; role: 'gm' | 'player' | 'table' }) {
  const { session, solo, role } = props
  const outcome = session.soloOutcome(solo)
  const { scale } = abilityRankRange(session.rules)
  const rankWord = scale?.[solo.rank]
  return (
    <div class={`solo-roll ${outcome.success ? 'success' : 'failure'}`}>
      <div class="solo-head">
        <span class="solo-title">Solo roll</span>
        {solo.visibility === 'gm' ? (
          <span class="badge solo-private">GM only</span>
        ) : (
          <span class="badge solo-public">Public</span>
        )}
        <span class={outcome.success ? 'result success' : 'result failure'}>
          {outcome.success ? 'Success' : 'Failure'}
        </span>
      </div>
      {solo.description && <p class="solo-description">{solo.description}</p>}
      <div class="solo-body">
        <div class="solo-opposition">
          <span class="solo-label">Opposition</span>
          <span class="solo-number">{solo.difficulty}</span>
          {solo.tier && <span class="solo-tier">({solo.tier})</span>}
        </div>
        <div class="solo-attempt">
          <span class="solo-label">
            Rank {solo.rank}
            {rankWord && ` \u00b7 ${rankWord}`}
          </span>
          <div class="dice-faces">
            {solo.roll.dice.map((d, i) => (
              <Die value={d} faceId={solo.roll.faces?.[i]} faces={session.rules.challenges.faces} />
            ))}
          </div>
          <div class="solo-sum">{outcome.sum}</div>
          <div class="solo-diff">{signed(outcome.difference)}</div>
        </div>
      </div>
      {role === 'gm' && (
        <button
          type="button"
          class="small solo-reveal"
          hx-post={`/gm/solo/visibility?id=${solo.id}&to=${solo.visibility === 'gm' ? 'public' : 'gm'}`}
          hx-swap="none"
        >
          {solo.visibility === 'gm' ? 'Show the table' : 'Hide again'}
        </button>
      )}
    </div>
  )
}

/**
 * The solo-roll section: the GM's "Start solo roll" button and the last roll. Its own swap target
 * so a solo roll never disturbs the challenge board, and mounted on all three screens — it renders
 * nothing at all when there is no roll to show the viewer.
 */
export function SoloRollBoard(props: { session: Session; role: 'gm' | 'player' | 'table'; oob?: boolean }) {
  const { session, role } = props
  const solo = session.currentSoloRoll()
  const visible = solo && (role === 'gm' || solo.visibility === 'public')
  return (
    <section id="solo-board" class="solo-board" hx-swap-oob={oobAttr(props.oob)}>
      {role === 'gm' && (
        <button type="button" class="small" onclick="document.getElementById('solo-dialog').showModal()">
          Start solo roll
        </button>
      )}
      {visible && <SoloRollCard session={session} solo={solo} role={role} />}
    </section>
  )
}

/** Clears the solo dialog back to its defaults after a roll, then closes it. */
const AFTER_SOLO = [
  'if (!event.detail.successful) return;',
  'const d = Alpine.$data(this);',
  "Object.assign(d, { description: '', tier: d.startTier, value: d.startValue, rank: d.startRank, visibility: 'gm' });",
  "this.closest('dialog').close()",
].join(' ')

/**
 * GM-only dialog for a solo roll: pick an opposition number off the difficulty ladder and nudge it
 * by 1s (the same idea as the circumstance stepper), pick the rank to roll at, choose whether the
 * table sees it, and roll. Everything is Alpine state until the one POST. Lives outside the boards
 * so live updates can't close it mid-edit.
 */
export function SoloRollDialog(props: { session: Session }) {
  const { session } = props
  const { difficulties } = session.rules.challenges
  const { min, max, def, scale } = abilityRankRange(session.rules)
  const ranks = Array.from({ length: max - min + 1 }, (_, i) => min + i)
  // The dialog opens on the first rung of the ladder, named, so the indicator is never blank.
  const startValue = difficulties[0]?.value ?? 7
  const startTier = difficulties[0]?.id ?? ''
  const state = {
    description: '',
    /** Which ladder tier the number came from; cleared as soon as a nudge moves it off. */
    tier: startTier,
    value: startValue,
    rank: def,
    visibility: 'gm',
    startValue,
    startTier,
    startRank: def,
    // Kept so a nudge can tell whether the number still sits on a tier, and name it when it does.
    tiers: difficulties.map((d) => ({ id: d.id, label: d.label, value: d.value })),
  }
  return (
    <dialog id="solo-dialog" class="challenge-dialog solo-dialog">
      <form hx-post="/gm/solo/roll" hx-swap="none" x-data={JSON.stringify(state)} hx-on--after-request={AFTER_SOLO}>
        <header class="dialog-head">
          <h3>Solo roll</h3>
          <button type="button" class="small" x-on:click="$el.closest('dialog').close()">
            Close
          </button>
        </header>

        <label class="challenge-description-field">
          <span>What is it for? (optional)</span>
          <input
            name="description"
            x-model="description"
            placeholder="e.g. Does the guard notice the open window?"
            maxlength={200}
            autocomplete="off"
          />
        </label>

        <section class="side-pick">
          <h4>Opposition</h4>
          <div class="big-indicator">
            <span class="bi-ability">Difficulty</span>
            <span class="bi-value">
              <span x-text="value">{startValue}</span>
              <span
                class="bi-tier"
                x-cloak
                x-show="tier"
                x-text="'(' + ((tiers.find((t) => t.id === tier) || {}).label || '') + ')'"
              ></span>
            </span>
          </div>
          {/* Nudging by 1 keeps the number but drops the tier name once it no longer matches. */}
          <div class="circumstance-set solo-nudge">
            <span class="circumstance-legend">Nudge</span>
            <div class="circumstance-controls">
              <button
                type="button"
                class="circumstance-step"
                x-on:click="value = value - 1; tier = (tiers.find((t) => t.value === value) || {}).id || ''"
              >
                {'\u2212'}
              </button>
              <output x-text="value">{startValue}</output>
              <button
                type="button"
                class="circumstance-step"
                x-on:click="value = value + 1; tier = (tiers.find((t) => t.value === value) || {}).id || ''"
              >
                +
              </button>
            </div>
          </div>
          <div class="pick-col">
            {difficulties.map((d) => (
              <button
                type="button"
                class="pick-btn diff-btn"
                x-bind:class={`{ on: value === ${d.value} }`}
                x-on:click={`value = ${d.value}; tier = '${d.id}'`}
              >
                <span class="label">{d.label}</span>
                <span class="diff-value">{d.value}</span>
              </button>
            ))}
          </div>
        </section>

        <section class="side-pick">
          <h4>Roll at rank</h4>
          <div class="pick-col">
            {ranks.map((r) => (
              <button
                type="button"
                class="pick-btn"
                x-bind:class={`{ on: rank === ${r} }`}
                x-on:click={`rank = ${r}`}
              >
                <span class="label">{scale?.[r] ?? `Rank ${r}`}</span>
                <span class="diff-value">{r}</span>
              </button>
            ))}
          </div>
        </section>

        <section class="side-pick">
          <h4>Who sees it</h4>
          <div class="solo-visibility">
            <button
              type="button"
              class="pick-btn"
              x-bind:class="{ on: visibility === 'gm' }"
              x-on:click="visibility = 'gm'"
            >
              <span class="label">GM only</span>
            </button>
            <button
              type="button"
              class="pick-btn"
              x-bind:class="{ on: visibility === 'public' }"
              x-on:click="visibility = 'public'"
            >
              <span class="label">Public</span>
            </button>
          </div>
        </section>

        <input type="hidden" name="difficulty" x-model="value" />
        <input type="hidden" name="tier" x-model="tier" />
        <input type="hidden" name="rank" x-model="rank" />
        <input type="hidden" name="visibility" x-model="visibility" />
        <button type="submit" class="primary">
          Roll
        </button>
      </form>
    </dialog>
  )
}

/**
 * One contestant's column: who they are, their two checks, and — while committing — the controls
 * for the player whose side it is. What has been committed is **hidden from everyone else until
 * both sides are ready**, so the column shows a "committed" marker instead of the numbers.
 */
function ContestantColumn(props: {
  session: Session
  opp: Opposition
  side: OppositionSide
  role: 'gm' | 'player' | 'table'
  viewerCharId?: string
}) {
  const { session, opp, side, role, viewerCharId } = props
  const one = opp[side]
  const phase = session.oppositionPhase(opp)
  const outcome = session.oppositionOutcome(opp)
  const open = session.oppositionCommitVisible(opp, side, role, viewerCharId)
  const won = outcome?.winner === side
  const mine = !!one.charId && one.charId === viewerCharId
  // The player whose side it is commits; the GM can act for any side (an NPC has nobody else).
  const acting = phase === 'committing' && !one.ready && (mine || role === 'gm')
  const canReady = phase === 'committing' && (mine || role === 'gm')
  const hidden = !open && (one.exertionCore + one.exertionSupport > 0 || !!one.skill)
  const skill = one.charId ? session.oppositionSkillState(one) : null

  const checkRow = (check: 'core' | 'support', label: string) => {
    const rolled = check === 'core' ? one.core : one.support
    const abilityId = check === 'core' ? one.coreAbility : one.supportAbility
    const field = abilityId ? (session.rules.fields.get(abilityId) as NumberField | undefined) : undefined
    const rank = check === 'core' ? one.coreRank : one.supportRank
    const bonus = open
      ? check === 'core'
        ? one.exertionCore + one.skillCore
        : one.exertionSupport + one.skillSupport
      : 0
    const sum = rolled ? session.oppositionSum(one, check) : null
    const winsIt = outcome && (check === 'core' ? outcome.core.winner : outcome.support.winner) === side
    return (
      <div
        class={`opp-check ${winsIt ? 'takes-it' : ''}`}
        style={field?.color ? `--field-color: ${field.color}; --field-ink: ${field.ink}` : undefined}
      >
        <div class="opp-check-head">
          <span class="opp-check-label">{label}</span>
          <IconChip icon={field?.icon} />
          <span class="opp-ability">{field?.label ?? (rank !== null ? `Rank ${rank}` : '\u2014')}</span>
        </div>
        {rolled ? (
          <>
            <div class="dice-faces">
              {rolled.dice.map((d, i) => (
                <Die value={d} faceId={rolled.faces?.[i]} faces={session.rules.challenges.faces} />
              ))}
              {bonus !== 0 && <span class="skill-bonus">{signed(bonus)}</span>}
            </div>
            <div class="opp-sum">{sum}</div>
          </>
        ) : (
          <div class="opp-waiting">{open && bonus !== 0 ? `committed ${signed(bonus)}` : '\u2014'}</div>
        )}
        {acting && <CommitControls session={session} opp={opp} one={one} check={check} />}
      </div>
    )
  }

  return (
    <div class={`opp-side ${won ? 'won' : ''} ${outcome && !won && outcome.winner ? 'lost' : ''}`}>
      <div class="opp-name">
        <span>{one.name}</span>
        {!one.charId && <span class="badge opp-npc">NPC</span>}
        {one.ready && phase === 'committing' && <span class="badge opp-ready">Ready</span>}
      </div>
      {hidden && <p class="opp-hidden">Bonus committed — hidden until both are ready</p>}
      {checkRow('core', 'Core')}
      {checkRow('support', 'Support')}
      {open && skill && one.skill && (
        <p class="opp-skill-left">
          {skill.label}: <b>{skill.left}</b> left of {skill.rank}
        </p>
      )}
      {acting && one.charId && <SkillPick session={session} opp={opp} one={one} />}
      {canReady && (
        <button
          type="button"
          class={one.ready ? 'small' : 'primary'}
          hx-post={`/gm/opposition/ready?side=${side}&to=${one.ready ? '0' : '1'}`}
          hx-swap="none"
        >
          {one.ready ? 'Not ready after all' : 'Ready'}
        </button>
      )}
      {phase === 'rolling' && !one.core && (mine || role === 'gm') && (
        <button type="button" class="primary" hx-post={`/gm/opposition/roll?side=${side}`} hx-swap="none">
          Roll
        </button>
      )}
      {phase === 'rolling' && one.core && <p class="muted">Rolled — waiting for the other side</p>}
    </div>
  )
}

/** Stamina/willpower burned onto one check, and (for a skill) the points put on it. */
function CommitControls(props: {
  session: Session
  opp: Opposition
  one: Contestant
  check: 'core' | 'support'
}) {
  const { session, opp, one, check } = props
  if (!one.charId) return null // an NPC commits nothing
  const char = session.characters.get(one.charId)
  if (!char) return null
  const side: OppositionSide = opp.a.charId === one.charId ? 'a' : 'b'
  const skill = session.oppositionSkillState(one)
  const onCheck = check === 'core' ? one.skillCore : one.skillSupport
  const post = (path: string) => `/c/${one.charId}/opposition/${path}`
  return (
    <div class="opp-commit">
      {session.rules.challenges.exertionSources.map((statId) => {
        const stat = session.statOf(char, statId)
        const field = session.rules.fields.get(statId)
        if (!stat) return null
        return (
          <button
            type="button"
            class="exert-btn"
            style={field?.color ? `--field-color: ${field.color}; --field-ink: ${field.ink}` : undefined}
            hx-post={`${post('exert')}?side=${side}&check=${check}`}
            hx-vals={JSON.stringify({ stat: statId })}
            hx-swap="none"
            disabled={stat.current <= 0 || undefined}
            title={`Burn 1 ${field?.label ?? statId} for +1 on this check`}
          >
            <IconChip icon={field?.icon} />
            <span class="label">+1</span>
          </button>
        )
      })}
      {skill && one.skill && (
        <span class="opp-skill-step">
          <button
            type="button"
            class="circumstance-step"
            hx-post={`${post('skill-points')}?side=${side}`}
            hx-vals={JSON.stringify(
              check === 'core'
                ? { core: Math.max(0, onCheck - 1), support: one.skillSupport }
                : { core: one.skillCore, support: Math.max(0, onCheck - 1) },
            )}
            hx-swap="none"
            disabled={onCheck <= 0 || undefined}
          >
            {'\u2212'}
          </button>
          <output>{onCheck}</output>
          <button
            type="button"
            class="circumstance-step"
            hx-post={`${post('skill-points')}?side=${side}`}
            hx-vals={JSON.stringify(
              check === 'core'
                ? { core: onCheck + 1, support: one.skillSupport }
                : { core: one.skillCore, support: onCheck + 1 },
            )}
            hx-swap="none"
            disabled={skill.left <= 0 || undefined}
          >
            +
          </button>
        </span>
      )}
    </div>
  )
}

/** Declares which trained skill this side is committing (its rank is then split per check). */
function SkillPick(props: { session: Session; opp: Opposition; one: Contestant }) {
  const { session, one } = props
  const skills = [...session.rules.fields.values()].filter(
    (f): f is NumberField => f.type === 'number' && f.trained,
  )
  if (!skills.length) return null
  return (
    <label class="skill-pick">
      Skill bonus
      <select
        name="skill"
        hx-post={`/c/${one.charId}/opposition/skill`}
        hx-trigger="change"
        hx-swap="none"
      >
        <option value="">None</option>
        {skills.map((f) => (
          <option value={f.id} selected={one.skill === f.id || undefined}>
            {f.label}
          </option>
        ))}
      </select>
    </label>
  )
}

/** What the contest is waiting on, in a line everyone can read. */
function oppositionStatus(session: Session, opp: Opposition) {
  const phase = session.oppositionPhase(opp)
  if (phase === 'committing') {
    const waiting = [opp.a, opp.b].filter((o) => !o.ready).map((o) => o.name)
    return `Committing — waiting on ${waiting.join(' and ')}`
  }
  if (phase === 'rolling') {
    const waiting = [opp.a, opp.b].filter((o) => !o.core).map((o) => o.name)
    return waiting.length ? `Both ready — waiting for ${waiting.join(' and ')} to roll` : 'Rolling\u2026'
  }
  const outcome = session.oppositionOutcome(opp)!
  if (!outcome.winner) return 'Tie — the GM rules on it'
  const winner = outcome.winner === 'a' ? opp.a.name : opp.b.name
  const degrees = outcome.degrees === 0 ? 'by a hair' : `by ${outcome.degrees} degree${outcome.degrees > 1 ? 's' : ''}`
  const split = outcome.decidedBy === 'support' ? ' (the core check was level)' : ''
  return `${winner} wins ${degrees}${split}`
}

/**
 * The opposition-roll section: the GM's "Start opposition roll" button and the contest itself.
 * Its own swap target, and mounted on all three screens — a contest is public (the hidden part is
 * only what each side has committed, until both are ready).
 */
export function OppositionBoard(props: {
  session: Session
  role: 'gm' | 'player' | 'table'
  viewerCharId?: string
  oob?: boolean
}) {
  const { session, role, viewerCharId } = props
  const opp = session.currentOpposition()
  const outcome = opp && session.oppositionOutcome(opp)
  return (
    <section id="opposition-board" class="opposition-board" hx-swap-oob={oobAttr(props.oob)}>
      {role === 'gm' && (
        <button type="button" class="small" onclick="document.getElementById('opposition-dialog').showModal()">
          Start opposition roll
        </button>
      )}
      {opp && (
        <div class={`opposition ${outcome ? 'resolved' : ''}`}>
          <div class="opp-head">
            <h3 class="opp-description">{opp.description}</h3>
            <span class="stakes stakes-high">High stakes</span>
          </div>
          <p class="opp-status">{oppositionStatus(session, opp)}</p>
          <div class="opp-sides">
            <ContestantColumn session={session} opp={opp} side="a" role={role} viewerCharId={viewerCharId} />
            <span class="opp-versus">vs</span>
            <ContestantColumn session={session} opp={opp} side="b" role={role} viewerCharId={viewerCharId} />
          </div>
        </div>
      )}
    </section>
  )
}

/** Clears the opposition dialog's picks after a contest starts, then closes it. */
const AFTER_OPPOSITION = [
  'if (!event.detail.successful) return;',
  'const d = Alpine.$data(this);',
  "Object.assign(d, { description: '',",
  "  aKind: 'character', aChar: '', aCore: '', aSupport: '', aName: '', aCoreRank: d.defRank, aSupportRank: d.defRank,",
  "  bKind: 'character', bChar: '', bCore: '', bSupport: '', bName: '', bCoreRank: d.defRank, bSupportRank: d.defRank });",
  "this.closest('dialog').close()",
].join(' ')

/**
 * One side of the opposition dialog: a player's character with two of its abilities, or an NPC
 * with a name and two flat ranks. Everything is Alpine state on the form, under the `p` prefix
 * ('a' or 'b'), so the two sides share this markup.
 */
function ContestantPicker(props: {
  title: string
  p: 'a' | 'b'
  abilities: NumberField[]
  characters: { id: string; name: string }[]
  ranks: number[]
  scale?: Record<number, string>
}) {
  const { title, p: side, abilities, characters, ranks, scale } = props
  const kind = `${side}Kind`
  const rankCol = (varName: string) => (
    <div class="pick-col">
      {ranks.map((r) => (
        <button
          type="button"
          class="pick-btn"
          x-bind:class={`{ on: ${varName} === ${r} }`}
          x-on:click={`${varName} = ${r}`}
        >
          <span class="label">{scale?.[r] ?? `Rank ${r}`}</span>
          <span class="diff-value">{r}</span>
        </button>
      ))}
    </div>
  )
  const abilityCol = (varName: string) => (
    <div class="pick-col">
      {abilities.map((f) => (
        <button
          type="button"
          class="pick-btn ability-btn"
          style={f.color ? `--field-color: ${f.color}; --field-ink: ${f.ink}` : undefined}
          x-bind:class={`{ on: ${varName} === '${f.id}' }`}
          x-on:click={`${varName} = '${f.id}'`}
        >
          <IconChip icon={f.icon} />
          <span class="label">{f.label}</span>
        </button>
      ))}
    </div>
  )
  return (
    <section class="side-pick opp-pick">
      <h4>{title}</h4>
      <div class="opp-kind">
        <button
          type="button"
          class="pick-btn"
          x-bind:class={`{ on: ${kind} === 'character' }`}
          x-on:click={`${kind} = 'character'`}
        >
          <span class="label">Player</span>
        </button>
        <button
          type="button"
          class="pick-btn"
          x-bind:class={`{ on: ${kind} === 'npc' }`}
          x-on:click={`${kind} = 'npc'`}
        >
          <span class="label">NPC</span>
        </button>
      </div>

      <div x-show={`${kind} === 'character'`}>
        {characters.length === 0 ? (
          <p class="muted">No finished characters yet.</p>
        ) : (
          <div class="pick-col">
            {characters.map((c) => (
              <button
                type="button"
                class="pick-btn"
                x-bind:class={`{ on: ${side}Char === '${c.id}' }`}
                x-on:click={`${side}Char = '${c.id}'`}
              >
                <span class="label">{c.name}</span>
              </button>
            ))}
          </div>
        )}
        <h5>Core ability</h5>
        {abilityCol(`${side}Core`)}
        <h5>Supporting ability</h5>
        {abilityCol(`${side}Support`)}
      </div>

      <div x-show={`${kind} === 'npc'`} x-cloak>
        <input
          x-model={`${side}Name`}
          placeholder="NPC name, e.g. Gate guard"
          maxlength={40}
          autocomplete="off"
        />
        <h5>Core rank</h5>
        {rankCol(`${side}CoreRank`)}
        <h5>Supporting rank</h5>
        {rankCol(`${side}SupportRank`)}
      </div>
    </section>
  )
}

/**
 * GM-only dialog for an opposition roll: two contestants, each a player's character with two
 * abilities or an NPC with two ranks. No difficulty is picked — the two sides are compared with
 * each other — and it is always high stakes, so nothing is chosen for either.
 */
export function OppositionDialog(props: { session: Session }) {
  const { session } = props
  const { rules } = session
  const abilities = [...rules.fields.values()].filter((f): f is NumberField => isBaseField(f) && !f.trained)
  const characters = [...session.characters.values()]
    .filter((c) => c.status === 'active')
    .map((c) => ({ id: c.id, name: c.name }))
  const { min, max, def, scale } = abilityRankRange(rules)
  const ranks = Array.from({ length: max - min + 1 }, (_, i) => min + i)
  const state = {
    description: '',
    defRank: def,
    aKind: 'character',
    aChar: '',
    aCore: '',
    aSupport: '',
    aName: '',
    aCoreRank: def,
    aSupportRank: def,
    bKind: 'character',
    bChar: '',
    bCore: '',
    bSupport: '',
    bName: '',
    bCoreRank: def,
    bSupportRank: def,
  }
  // A side is settled once it is a character with both abilities, or an NPC (ranks always have
  // a value, and the name falls back to "NPC" server-side).
  const ready = (p: 'a' | 'b') => `(${p}Kind === 'npc' ? true : (${p}Char && ${p}Core && ${p}Support))`
  return (
    <dialog id="opposition-dialog" class="challenge-dialog opposition-dialog">
      <form
        hx-post="/gm/opposition/start"
        hx-swap="none"
        x-data={JSON.stringify(state)}
        hx-on--after-request={AFTER_OPPOSITION}
      >
        <header class="dialog-head">
          <h3>Opposition roll</h3>
          <button type="button" class="small" x-on:click="$el.closest('dialog').close()">
            Close
          </button>
        </header>

        <label class="challenge-description-field">
          <span>What is the contest?</span>
          <input
            name="description"
            x-model="description"
            placeholder="e.g. Arm wrestle over the last ration"
            maxlength={200}
            autocomplete="off"
            required
          />
        </label>

        <div class="opp-pickers">
          <ContestantPicker
            title="First side"
            p="a"
            abilities={abilities}
            characters={characters}
            ranks={ranks}
            scale={scale}
          />
          <ContestantPicker
            title="Second side"
            p="b"
            abilities={abilities}
            characters={characters}
            ranks={ranks}
            scale={scale}
          />
        </div>

        {(['a', 'b'] as const).map((p) => (
          <>
            <input type="hidden" name={`${p}_kind`} x-model={`${p}Kind`} />
            <input type="hidden" name={`${p}_char`} x-model={`${p}Char`} />
            <input type="hidden" name={`${p}_core`} x-model={`${p}Core`} />
            <input type="hidden" name={`${p}_support`} x-model={`${p}Support`} />
            <input type="hidden" name={`${p}_name`} x-model={`${p}Name`} />
            <input type="hidden" name={`${p}_core_rank`} x-model={`${p}CoreRank`} />
            <input type="hidden" name={`${p}_support_rank`} x-model={`${p}SupportRank`} />
          </>
        ))}
        <button
          type="submit"
          class="primary"
          x-bind:disabled={`!(description.trim() && ${ready('a')} && ${ready('b')})`}
        >
          Start contest
        </button>
      </form>
    </dialog>
  )
}

export function ChallengeBoard(props: { session: Session; role: 'gm' | 'player' | 'table'; viewerCharId?: string; oob?: boolean }) {
  const { session, role, viewerCharId } = props
  const ch = session.currentChallenge()
  const history = session.challenges.slice(0, -1).reverse()
  return (
    <section id="challenge-board" class="challenge-board" hx-swap-oob={oobAttr(props.oob)}>
      {role === 'gm' && (
        <button type="button" class="primary" onclick="document.getElementById('challenge-dialog').showModal()">
          Start new challenge
        </button>
      )}
      {ch ? (
        <CurrentChallenge session={session} ch={ch} role={role} viewerCharId={viewerCharId} />
      ) : (
        <p class="muted">No challenge yet.</p>
      )}
      {role !== 'player' && <ChallengeLog session={session} entries={history} />}
    </section>
  )
}
