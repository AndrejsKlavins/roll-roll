// Public challenge board: the challenge's one difficulty with the skill and circumstance working
// under it, the framing and resolution rolls beside each other, and a history log of past
// challenges. Shared between /table (the shared screen), /gm (setup + oversight) and the player's
// own page (pick/roll controls) — role picks what's interactive.
import { raw } from 'hono/html'
import { abilityRankRange } from '../rules'
import type { ApproachEffect, ApproachWhen, FaceName, Icon, NumberField } from '../rules'
import type { Child } from 'hono/jsx'
import { defence, poolLabel, tierEffect, woundLabel } from '../combat'
import { AttackLogLine, EnemyAttackLogLine } from './combat'
import {
  APPROACH_DIE_SIDES,
  isBaseField,
  MAX_CIRCUMSTANCE,
  type Contestant,
  type GroupTask,
  type Opposition,
  type OppositionSide,
  type SoloRoll,
  type Challenge,
  type ChallengeMath,
  type ChallengeSide,
  type DieMarker,
  type EnemyAttack,
  type Session,
  type SideOutcome,
} from '../session'

const oobAttr = (oob?: boolean) => (oob ? 'true' : undefined)
const signed = (n: number) => (n === 0 ? '0' : n > 0 ? `+${n}` : String(n))
const stakesLabel = (s: string) => s[0]!.toUpperCase() + s.slice(1)

/** Boons / complications in words: the stakes' own, plus whatever the framing rung added. */
function degreeText(degrees: number) {
  if (degrees === 0) return null
  const n = Math.abs(degrees)
  const word = degrees > 0 ? 'boon' : 'complication'
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
  /** Set while "Set die value" may pick this die: its index, for the roll box's Alpine state. */
  pickIndex?: number
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
  // "Set die value" is browser-side until the face is picked: while the roll box is `setting`, a
  // tap on this die selects it (`die`), and the box then offers its faces.
  if (props.pickIndex !== undefined) {
    const i = props.pickIndex
    return (
      <span
        class={cls}
        style={style}
        x-on:click={`if (setting) die = ${i}`}
        x-bind:class={`{ 'die-tappable die-face-change': setting, 'die-picked': setting && die === ${i} }`}
      >
        {inner}
      </span>
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

/** What an approach effect (or "Set die value") did to a die, named under it. */
const markerLabel = (marker: NonNullable<DieMarker>) =>
  marker === 'raised'
    ? 'Raised'
    : marker === 'lowered'
      ? 'Lowered'
      : marker === 'matched'
        ? 'Matched'
        : marker === 'copied'
          ? 'Copy'
          : marker === 'set'
            ? 'Set'
            : marker === 'maxed'
              ? 'Max'
              : 'Squashed'

/**
 * The challenge's one difficulty — "Difficulty", the number, and its tier — sitting beside the
 * challenge's description (user decision, matching the table's own layout). The skill is a bonus
 * on the rolls, not on this number (it shows beside the dice instead), so only the GM's
 * circumstance moves it, and then everyone sees the working.
 */
function DifficultyPanel(props: { math: ChallengeMath; tier: string | null; controls?: Child }) {
  const { math, tier } = props
  return (
    <div class="difficulty-panel">
      <div class="difficulty-label">
        <span>Difficulty</span>
      </div>
      <div class="difficulty-target">
        {math.target}
        {tier && <span class="difficulty-tier">({tier})</span>}
      </div>
      {math.circumstance !== 0 && (
        <p class="difficulty-calc">
          <span class="calc-part">{math.difficulty}</span>
          <span class={math.circumstance > 0 ? 'calc-part hinder' : 'calc-part help'}>
            {math.circumstance > 0 ? '+' : '−'} {Math.abs(math.circumstance)} circumstance
          </span>
          <span class="calc-part calc-total">= {math.target}</span>
        </p>
      )}
      {props.controls}
    </div>
  )
}

/** One +N/−N chip beside the dice: the skill declared, exertion spent, or a framing bonus. */
function bonusChip(value: number, label: string, icon: Icon | undefined, tone: string): Child {
  // No leading "+" here (user decision) — it's already read as an addend by the "+" between
  // terms, so the sign only needs to speak up when the chip is actually working against the
  // player. String(value) does exactly that: "-1" for a negative, plain "1" otherwise.
  return (
    <span class={`equation-bonus ${tone}`}>
      <span class="equation-bonus-value">{String(value)}</span>
      <span class="equation-bonus-label">
        {icon && <IconChip icon={icon} />}
        {label}
      </span>
    </span>
  )
}

/**
 * Dice and bonus chips laid out as a running sum, with "+" between every term but the first and
 * "=" before the result. `rows` is pre-split by the caller — dice on the first line, every bonus
 * chip pushed to the second (user decision), so a roll with no bonuses is the only time this is
 * one line instead of two. A row too long for its own line still wraps within itself (CSS), so a
 * check with several extra dice is never one very long row either.
 */
function Equation(props: { rows: Child[][]; result?: Child }) {
  const rows = props.rows.filter((row) => row.length > 0)
  let index = 0
  return (
    <div class="equation">
      {rows.map((row, ri) => (
        <div class="equation-row">
          {row.map((term) => {
            const op = index > 0 && <span class="equation-op">+</span>
            index++
            return (
              <>
                {op}
                {term}
              </>
            )
          })}
          {ri === rows.length - 1 && props.result && (
            <span class="equation-final">
              <span class="equation-op equation-eq">=</span>
              {props.result}
            </span>
          )}
        </div>
      ))}
    </div>
  )
}

/**
 * One of the two rolls: its ability, the dice and bonuses that add up to it, and (once they are
 * in) the sum and how far off the target it landed, as a running equation. Framing's own footer
 * names the rung it landed on; resolution's names the final verdict — both read from `caption`,
 * so this component itself knows nothing about what a rung or a boon is.
 */
function RollBox(props: {
  field: NumberField | undefined
  label: string
  /** "Framing" / "Resolution" — which of the two this is, above the ability's name. */
  kind: string
  side: ChallengeSide | null
  outcome: SideOutcome | null
  faces: FaceName[]
  /** The declared skill's rank: a bonus on this result, shown beside the dice. */
  skillBonus: number
  skillLabel: string | null
  /** The declared skill's own icon for its bonus chip — not the ability's. */
  skillIcon: Icon | null
  exertion: number
  /** The framing rung's bonus to this roll — resolution only. */
  framingBonus?: number
  /** Set when the viewer may act on the dice here (exertion reroll, pending approach effect). */
  dieAction?: (index: number) => DieAction | undefined
  /** GM and table screens name the result; the player sees their own controls instead. */
  attemptLabel?: boolean
  /** What the roll's own footer says once it has landed: the rung, or the success/degree line. */
  caption?: Child
  /** The custom ± on this roll (the GM's or player's hand adjustment), shown as "Custom". */
  custom: number
  /** Supporters' dice on this roll: each is a chip named after the helper. */
  supports?: { name: string; value: number }[]
  /** More bonus chips (an attack's item bonuses, hit tier and critical die). */
  extras?: { value: number; label: string; tone: string }[]
  /** Shown instead of the result when the dice are in but don't count (a missed attack's damage). */
  note?: Child
  /** Which roll this is, for the hand-edit routes. */
  roll: 'framing' | 'resolution'
  /**
   * Set when the viewer may hand-edit this roll (the GM, or the rolling player while it is open):
   * the route prefix — `/gm/challenge` or `/c/:id/challenge`. It brings the −1 / +1 / Set die
   * controls.
   */
  editUrl?: string
}) {
  const { field, label, side, outcome } = props
  // Set die value can't take over dice that something else is already waiting on (an exertion
  // reroll the player chose, or an approach effect's taps).
  const diceBusy = !!side && side.dice.some((_, i) => !!props.dieAction?.(i))
  const pickable = !!props.editUrl && !!side && !diceBusy
  const cls = ['difficulty-box', outcome && (outcome.success ? 'success' : 'failure')].filter(Boolean).join(' ')
  const diceTerms: Child[] = []
  const bonusTerms: Child[] = []
  if (side) {
    for (let i = 0; i < side.dice.length; i++) {
      diceTerms.push(
        <Die
          value={side.dice[i]!}
          faceId={side.faces?.[i]}
          faces={props.faces}
          discarded={side.discarded?.[i]}
          rerolled={side.rerolled?.[i]}
          changed={side.changed?.[i]}
          action={side.discarded?.[i] ? undefined : props.dieAction?.(i)}
          pickIndex={pickable && !side.discarded?.[i] ? i : undefined}
        />,
      )
    }
    if (props.skillBonus) bonusTerms.push(bonusChip(props.skillBonus, props.skillLabel ?? 'Skill', props.skillIcon ?? undefined, 'skill'))
    if (props.exertion) bonusTerms.push(bonusChip(props.exertion, 'Exertion', undefined, 'exertion'))
    if (props.framingBonus) {
      bonusTerms.push(bonusChip(props.framingBonus, 'Framing', undefined, props.framingBonus > 0 ? 'help' : 'hinder'))
    }
    if (props.custom) bonusTerms.push(bonusChip(props.custom, 'Custom', undefined, 'custom'))
    for (const sp of props.supports ?? []) bonusTerms.push(bonusChip(sp.value, sp.name, undefined, 'support'))
    for (const x of props.extras ?? []) if (x.value) bonusTerms.push(bonusChip(x.value, x.label, undefined, x.tone))
  }
  const edit = props.editUrl && side ? props.editUrl : null
  const step = (delta: number) => (
    <button
      type="button"
      class="roll-edit-btn"
      hx-post={`${edit}/custom?roll=${props.roll}&delta=${delta}`}
      hx-swap="none"
      title={`${delta > 0 ? 'Add' : 'Take'} 1 ${delta > 0 ? 'to' : 'from'} this roll (shown as Custom)`}
    >
      {delta > 0 ? '+1' : '\u22121'}
    </button>
  )
  return (
    <div
      class={cls}
      style={field?.color ? `--field-color: ${field.color}; --field-ink: ${field.ink}` : undefined}
      x-data={edit ? '{ setting: false, die: null }' : undefined}
    >
      <div class="roll-box-head">
        <span class="roll-kind">{props.kind}</span>
        <IconChip icon={field?.icon} />
        <span class="roll-ability">{label}</span>
        {edit && (
          <span class="roll-edit">
            {step(-1)}
            {step(1)}
            <button
              type="button"
              class="roll-edit-btn"
              x-on:click="setting = !setting; die = null"
              x-bind:class="setting && 'on'"
              disabled={diceBusy || undefined}
              title={diceBusy ? 'Finish what the dice are waiting on first' : 'Pick a die, then the face to set it to'}
            >
              <span x-text="setting ? 'Cancel' : 'Set die'">Set die</span>
            </button>
          </span>
        )}
      </div>
      {edit && side && pickable && (
        <SetDieFaces side={side} faces={props.faces} url={`${edit}/set-die?roll=${props.roll}`} />
      )}
      {side && outcome && (
        <div class="difficulty-result">
          {props.attemptLabel && <div class="attempt-label">Player attempt</div>}
          <Equation
            rows={[diceTerms, bonusTerms]}
            result={
              <span class="equation-result">
                <span class="difficulty-sum">{outcome.sum}</span>
                <span class="difficulty-diff">{signed(outcome.difference)}</span>
              </span>
            }
          />
          {props.caption}
        </div>
      )}
      {!outcome && props.note}
    </div>
  )
}

/**
 * The second half of "Set die value": once a die is tapped, a row of every face to set it to, in
 * the configured names and colours (worst to best). One row per die, shown by the roll box's
 * Alpine `die`, so every URL is plain server-rendered htmx. The face the die already shows is
 * disabled; a pick keeps the die's own rank shift (see Session.setDieFace).
 */
function SetDieFaces(props: { side: ChallengeSide; faces: FaceName[]; url: string }) {
  const { side, url } = props
  const faces = props.faces.length
    ? props.faces
    : [1, 2, 3, 4, 5, 6].map((value) => ({ value, label: String(value), color: '', ink: '' }))
  return (
    <div class="set-die" x-show="setting" x-cloak>
      <p class="set-die-prompt" x-show="die === null">
        Tap a die to set it
      </p>
      {side.dice.map((_, i) =>
        side.discarded?.[i] ? null : (
          <div class="set-die-faces" x-show={`die === ${i}`}>
            {faces.map((f) => (
              <button
                type="button"
                class="set-die-face"
                style={f.color ? `--face-color: ${f.color}` : undefined}
                hx-post={`${url}&index=${i}&face=${f.value}`}
                hx-swap="none"
                disabled={side.faces?.[i] === f.value || undefined}
              >
                {f.label}
              </button>
            ))}
          </div>
        ),
      )}
    </div>
  )
}

/**
 * GM only: nudges the challenge's circumstance modifier. It is added to the difficulty, so a plus
 * makes the challenge harder and a minus makes it easier. Offered from the moment the challenge
 * exists until it is closed — a ruling can land before the rolls or between them — and every
 * screen shows it in the calculation above. The legend sits above the buttons so the row stays
 * narrow enough for the GM column.
 */
function CircumstanceControls(props: { value: number }) {
  const { value } = props
  const step = (delta: number, label: string, disabled: boolean) => (
    <button
      type="button"
      class="circumstance-step"
      hx-post={`/gm/challenge/circumstance?delta=${delta}`}
      hx-swap="none"
      disabled={disabled || undefined}
      title={delta > 0 ? 'Circumstance against the player' : 'Circumstance in the player’s favour'}
    >
      {label}
    </button>
  )
  return (
    <div class="circumstance-set">
      <span class="circumstance-legend">Circumstance</span>
      <div class="circumstance-controls">
        {step(-1, '−', value <= -MAX_CIRCUMSTANCE)}
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
 * Approach + skill pick, then the roll — shown to the player before they roll. One stacked
 * button per approach, its description to the left; picking posts straight away (the pick lives
 * on the challenge, so the board comes back with the chosen one marked).
 *
 * Everything here is declared **before** the dice and nothing after: the approach die is rolled
 * with them, and the skill is a bonus on results that would otherwise already be on the table.
 */
/** The trained skills this character may declare — not ones hidden behind a trait they lack (magic). */
function skillsFor(session: Session, charId: string | null | undefined) {
  const char = charId ? session.characters.get(charId) : undefined
  return [...session.rules.fields.values()].filter(
    (f): f is NumberField => f.type === 'number' && f.trained && (!char || session.fieldVisible(char, f.id)),
  )
}

function ChallengeSetupControls(props: { session: Session; ch: Challenge; charId: string }) {
  const { session, ch, charId } = props
  const { rules } = session
  const skills = skillsFor(session, charId)
  return (
    <div class="challenge-player-setup">
      <div class="approach-pick">
        <span class="approach-legend">Approach (both rolls)</span>
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
        Skill
        <select name="skill" hx-post={`/c/${charId}/challenge/setup`} hx-trigger="change" hx-swap="none">
          <option value="">None</option>
          {skills.map((f) => (
            <option value={f.id} selected={ch.skill === f.id || undefined}>
              {f.label}
            </option>
          ))}
        </select>
      </label>
      {/* One press lands both checks together (user decision). */}
      <button
        type="button"
        class="primary"
        hx-post={`/c/${charId}/challenge/roll`}
        hx-swap="none"
        disabled={!ch.approach || undefined}
      >
        {ch.attack ? 'Roll to hit' : ch.framingAbility ? 'Roll framing and resolution' : 'Roll'}
      </button>
    </div>
  )
}

/**
 * The approach die: one plain d6 rolled with the challenge's dice. When it counts follows the
 * approach's `when` (always / only if a roll failed as it landed / the player's choice); what it
 * does on that face comes from `effects` in rules.yaml. Effects that need a die put the board in a
 * pending state and the dice of both rolls become tappable; extra dice ask which roll they join;
 * Perfect balance applies to both rolls the moment Activate is pressed.
 */
function ApproachDie(props: {
  session: Session
  ch: Challenge
  /** The viewer is the rolling player and the challenge is still open. */
  acting: boolean
  /** GM debug tool: offer a button per face, forcing the die onto it. */
  debug?: boolean
  charId?: string
}) {
  const { session, ch, acting } = props
  const state = session.approachState(ch)
  if (!state) return null
  const { effect } = state
  // "Challenge done" ends the pick too: an effect nobody applied in time simply went unused.
  const pending = state.pending && !!effect && !ch.closed
  // A `failure` approach is judged on both rolls at the moment they landed (Challenge.failingAtRoll).
  const skipped = ch.framing ? 'Skipped — both rolls succeeded' : 'Skipped — the roll succeeded'
  // What this face is (the effect's own words, or a plain note for an approach with no effects).
  const note = effect
    ? effect.label
    : state.status === 'active'
      ? ch.approachActivated
        ? 'Activated'
        : state.approach.when === 'failure'
          ? 'In effect — a roll failed'
          : 'In effect'
      : state.status === 'skipped'
        ? skipped
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
              ? skipped
              : effect.kind === 'lower_face' && !state.canActivate
                ? "Can't be used — every die is at its worst face"
                : effect.kind === 'max_face' && !state.canActivate
                  ? "Can't be used — every die is already at its top face"
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
      {/* Extra dice have no die to tap — the player picks which roll they join instead. */}
      {acting && pending && effect!.kind === 'extra_dice' && (
        <div class="approach-sides">
          {session.rollsInPlay(ch).map((roll) => {
            const id = roll === 'framing' ? ch.framingAbility : ch.resolutionAbility
            const field = id ? (session.rules.fields.get(id) as NumberField | undefined) : undefined
            return (
              <button
                type="button"
                class="approach-side-btn"
                style={field?.color ? `--field-color: ${field.color}; --field-ink: ${field.ink}` : undefined}
                hx-post={`/c/${props.charId}/challenge/approach-pick?effect=dice&roll=${roll}`}
                hx-swap="none"
              >
                <IconChip icon={field?.icon} />
                <span class="label">{roll === 'framing' ? 'Framing' : 'Resolution'}: {field?.label ?? id}</span>
              </button>
            )
          })}
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

/**
 * What the player (or everyone else, watching) is told to tap while an effect waits for a die.
 * Effects over several dice count down, so the prompt always says how many are still to come;
 * two-step effects (Tweak, Perfect choice) name the step they are on instead, and extra dice ask
 * for a roll. Perfect balance never gets here — it applies on Activate.
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
  if (effect.kind === 'lower_face') return `${who} a die to lower it one face`
  if (effect.kind === 'max_face') return `${who} a die to set it to its top face`
  if (effect.kind === 'extra_dice') {
    const extra = effect.dice === 1 ? 'the extra die' : `the ${effect.dice} extra dice`
    return acting ? `Pick the roll ${extra} join` : `Player picks the roll ${extra} join`
  }
  return step === 'first' ? `${who} a die to discard it` : `${who} another die to copy it`
}

/**
 * Exertion: burn a point of a pool stat (stamina/willpower) for one exertion, then choose what it
 * does — **+1** on a roll's result, or **Reroll a die**, which turns every die in play (added ones
 * too) into a tap target until one is rerolled or the player cancels. Shown to the rolling player
 * while the challenge is open.
 */
function ExertionControls(props: {
  session: Session
  ch: Challenge
  charId: string
  /** Where its buttons post: a challenge's routes, or (group task) the group's. */
  base?: string
}) {
  const { session, ch, charId } = props
  const base = props.base ?? `/c/${charId}/challenge`
  const char = session.characters.get(charId)!
  const available = session.availableExertion(ch)
  const sources = session.rules.challenges.exertionSources.flatMap((statId) => {
    const stat = session.rules.derived.find((d) => d.id === statId)
    const value = session.statOf(char, statId)
    return stat && value ? [{ stat, left: value.current }] : []
  })
  if (sources.length === 0) return null
  // A pending approach effect owns the dice, so a reroll can't be chosen until it is resolved.
  const approachBusy = ch.approachPicksLeft > 0
  const ability = (id: string | null) => (id ? session.rules.fields.get(id)?.label ?? id : null)
  const plusOne = (roll: 'framing' | 'resolution', label: string) => (
    <button
      type="button"
      class="exert-spend"
      hx-post={`${base}/spend-exertion`}
      hx-vals={JSON.stringify({ roll })}
      hx-swap="none"
    >
      +1 to {label}
    </button>
  )
  return (
    <div class="exertion">
      <p class="exertion-left">
        Exertion: <b>{available}</b>
        {available > 0 && !ch.exertionRerollArmed && <span class="muted"> — choose what it does</span>}
      </p>
      {available > 0 &&
        (ch.exertionRerollArmed ? (
          <div class="exert-options">
            <span class="exert-prompt">Tap any die to reroll it</span>
            <button
              type="button"
              class="exert-spend"
              hx-post={`${base}/reroll-mode?armed=0`}
              hx-swap="none"
            >
              Cancel
            </button>
          </div>
        ) : (
          <div class="exert-options">
            {session.rollsInPlay(ch).includes('framing') &&
              plusOne('framing', `${ch.attack ? 'hit' : 'framing'} (${ability(ch.framingAbility)})`)}
            {session.rollsInPlay(ch).includes('resolution') &&
              plusOne('resolution', `${ch.attack ? 'damage' : 'resolution'} (${ability(ch.resolutionAbility)})`)}
            <button
              type="button"
              class="exert-spend"
              hx-post={`${base}/reroll-mode?armed=1`}
              hx-swap="none"
              disabled={approachBusy || undefined}
              title={approachBusy ? 'Finish the approach effect first' : undefined}
            >
              Reroll a die
            </button>
          </div>
        ))}
      <div class="exert-buttons">
        {sources.map(({ stat, left }) => (
          <button
            type="button"
            class="exert-btn"
            style={stat.color ? `--field-color: ${stat.color}; --field-ink: ${stat.ink}` : undefined}
            hx-post={`${base}/exert`}
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

/** The rolling player's own ability values for the rolls in play (framing only when there is one). */
function ChallengeAbilities(props: { session: Session; ch: Challenge }) {
  const { session, ch } = props
  const char = ch.charId ? session.characters.get(ch.charId) : null
  if (!char) return null
  const ability = (id: string | null) => (id ? (session.rules.fields.get(id) as NumberField | undefined) : undefined)
  const fields = [ability(ch.framingAbility), ability(ch.resolutionAbility)].filter(Boolean) as NumberField[]
  return (
    <div class="challenge-abilities">
      <span class="challenge-player-name">{char.name}</span>
      {fields.map((f) => (
        <span>
          {f.label} {session.valueOf(char, f)}
        </span>
      ))}
    </div>
  )
}

/**
 * The framing box's own footer: the ladder rung it landed on, and what that rung is worth to the
 * resolution roll. It is derived, so a reroll or a point of exertion on the framing moves it the
 * moment it lands.
 */
/**
 * How far the result is from its next breakpoint — or, once nothing higher is left to reach (the
 * top framing rung, or normal/low stakes' one degree past a plain success), that it's already
 * there (user decision: say so rather than just going quiet).
 */
function NeedsLine(props: { pointsToNext: number | null }) {
  return (
    <p class="roll-caption-needs">
      {props.pointsToNext !== null ? `${props.pointsToNext} needed to improve result` : 'Already at its best'}
    </p>
  )
}

function FramingCaption(props: { math: ChallengeMath }) {
  const { math } = props
  if (!math.framing || !math.rung) return null
  const bonus = math.rungBonus
  const tone = bonus > 0 ? 'help' : bonus < 0 || math.rung.degrees < 0 ? 'hinder' : 'even'
  return (
    <div class={`roll-caption roll-caption-${tone}`}>
      <NeedsLine pointsToNext={math.framingPointsToNext} />
      <span class="roll-caption-title">{math.rung.label}</span>
      {bonus !== 0 && <span class="roll-caption-sub">({signed(bonus)} bonus to resolution)</span>}
    </div>
  )
}

/** The resolution box's own footer: success or failure, and whatever boons/complications it earned. */
function ResolutionCaption(props: { math: ChallengeMath }) {
  const { math } = props
  if (!math.resolution) return null
  const degrees = degreeText(math.degrees)
  return (
    <div class={`roll-caption ${math.resolution.success ? 'roll-caption-help' : 'roll-caption-hinder'}`}>
      <NeedsLine pointsToNext={math.resolutionPointsToNext} />
      <span class="roll-caption-title">{math.resolution.success ? 'Success' : 'Failure'}</span>
      {degrees && <span class="roll-caption-sub">({degrees})</span>}
    </div>
  )
}

/** An attack's hit box footer: the tier it landed on, what that does to the damage, how close the next tier is. */
function HitCaption(props: { math: ChallengeMath }) {
  const t = props.math.attack?.tier
  if (!props.math.framing || !t) return null
  const tone = t.miss || t.drop ? 'hinder' : t.id === 'normal' ? 'even' : 'help'
  return (
    <div class={`roll-caption roll-caption-${tone}`}>
      <NeedsLine pointsToNext={props.math.framingPointsToNext} />
      <span class="roll-caption-title">{t.label}</span>
      <span class="roll-caption-sub">({tierEffect(t)})</span>
    </div>
  )
}

/** An attack's damage box footer: the wound, and how close one more wound is. */
function WoundCaption(props: { math: ChallengeMath; pool: 'health' | 'mind' }) {
  const a = props.math.attack
  if (!props.math.resolution || !a) return null
  return (
    <div class={`roll-caption ${a.wounds > 0 ? 'roll-caption-help' : 'roll-caption-hinder'}`}>
      <p class="roll-caption-needs">{props.math.resolutionPointsToNext} needed for one more wound</p>
      <span class="roll-caption-title">{woundLabel(a.wounds)}</span>
      {a.wounds > 0 && (
        <span class="roll-caption-sub">
          (−{a.wounds} {poolLabel(props.pool)})
        </span>
      )}
    </div>
  )
}

/**
 * An attack's two numbers to beat, where a challenge has its one difficulty: the hit against the
 * enemy's defence (spent Evasion reads as 0, and says so) and the damage against the other one.
 * The GM's circumstance ± moves both.
 */
function AttackTargets(props: { ch: Challenge; math: ChallengeMath; controls?: Child }) {
  const a = props.ch.attack!
  const m = props.math.attack!
  const circ = props.math.circumstance
  const hitName = a.hitVs === 'evasion' && a.evasionSpent ? 'Evasion (spent)' : defence(a.hitVs).label
  return (
    <div class="difficulty-panel attack-targets">
      <div class="attack-target">
        <span class="difficulty-label">Hit vs {hitName}</span>
        <span class="difficulty-target">{m.hitTarget}</span>
      </div>
      <div class="attack-target">
        <span class="difficulty-label">Damage vs {defence(a.damageVs).label}</span>
        <span class="difficulty-target">{m.damageTarget}</span>
      </div>
      {circ !== 0 && (
        <p class="difficulty-calc">
          <span class={circ > 0 ? 'calc-part hinder' : 'calc-part help'}>
            {circ > 0 ? '+' : '−'} {Math.abs(circ)} circumstance on both
          </span>
        </p>
      )}
      {props.controls}
    </div>
  )
}

/** Full board for the current (last-started) challenge. Interactive parts only for role "player". */
function CurrentChallenge(props: { session: Session; ch: Challenge; role: 'gm' | 'player' | 'table'; viewerCharId?: string }) {
  const { session, ch, role, viewerCharId } = props
  const ability = (id: string | null) => (id ? (session.rules.fields.get(id) as NumberField | undefined) : undefined)
  const framingField = ability(ch.framingAbility)
  const resolutionField = ability(ch.resolutionAbility)
  const math = session.challengeMath(ch)
  const rolled = session.challengePhase(ch) !== 'setup'
  // A player's attack on an enemy: framing is the hit, resolution the damage (see Attack).
  const attack = ch.attack
  const am = math.attack
  // The glancing blow's discarded die is struck through on the damage dice (worked out live, so
  // it is marked here rather than stored on the roll).
  const damageSide =
    ch.resolution && am?.dropped != null
      ? { ...ch.resolution, discarded: ch.resolution.dice.map((_, i) => i === am.dropped || !!ch.resolution!.discarded?.[i]) }
      : ch.resolution
  const hitExtras = am ? [{ value: am.accuracy, label: 'Accuracy', tone: 'custom' }] : undefined
  const damageExtras = am
    ? [
        { value: am.weapon, label: 'Weapon', tone: 'custom' },
        { value: am.tier?.damageBonus ?? 0, label: am.tier?.label ?? 'Hit', tone: 'help' },
        { value: am.critValue ?? 0, label: 'Critical die', tone: 'help' },
      ]
    : undefined
  // Challenges store the number; name the tier the GM's own difficulty came from when one matches.
  const tier = session.rules.challenges.difficulties.find((d) => d.value === ch.difficulty)?.label ?? null
  // "Someone" before a player is assigned — the same fallback the rest of the app uses (app.tsx).
  const rollerName = (ch.charId ? session.characters.get(ch.charId)?.name : null) ?? 'Someone'
  const isViewerTurn = role === 'player' && !!viewerCharId && ch.charId === viewerCharId
  // Only the player who rolled acts on it, and only once the dice are in, until the GM closes it.
  const acting = isViewerTurn && rolled && !ch.closed
  const exertion = session.availableExertion(ch)
  // Supporters' rolled dice, per check, for that check's breakdown.
  const supportsOn = (roll: 'framing' | 'resolution') =>
    ch.supporters.flatMap((sp) =>
      sp.roll === roll && sp.die ? [{ name: session.characters.get(sp.charId)?.name ?? 'Support', value: sp.die.value }] : [],
    )
  // The GM and the rolling player can both hand-edit a rolled, open challenge (custom ±1, Set die).
  const editUrl =
    rolled && !ch.closed
      ? role === 'gm'
        ? '/gm/challenge'
        : acting
          ? `/c/${viewerCharId}/challenge`
          : undefined
      : undefined
  const approach = session.approachState(ch)
  // An attack alters one roll at a time: the hit, then (once rolled) only the damage.
  const open = session.rollsInPlay(ch)
  const editFor = (roll: 'framing' | 'resolution') => (open.includes(roll) ? editUrl : undefined)
  const step = session.attackStep(ch)
  // Once the player has chosen "Reroll a die" for a point of exertion, every die in play on both
  // rolls is a reroll button — added dice included — until one is picked or they cancel.
  const rerollAction = (roll: 'framing' | 'resolution') => {
    if (!acting || !ch.exertionRerollArmed || approach?.pending || exertion <= 0) return undefined
    return (index: number): DieAction => ({
      kind: 'reroll',
      url: `/c/${viewerCharId}/challenge/reroll?roll=${roll}&index=${index}`,
      title: 'Reroll with exertion',
    })
  }
  // A pending approach effect owns the dice of both rolls while it lasts — it is the step the
  // board is waiting on, so it takes them over from the reroll buttons.
  const pendingKind = acting && approach?.pending ? approach.effect?.kind : undefined
  const dieAction = (roll: 'framing' | 'resolution') => (open.includes(roll) ? openDieAction(roll) : undefined)
  const openDieAction = (roll: 'framing' | 'resolution') => {
    // Multi-die effects never take the same die twice, so dice already used drop out.
    const picked = (index: number) => ch.approachPicked.includes(`${roll}:${index}`)
    const tap = (kind: DieAction['kind'], effect: string, title: string) => (index: number) =>
      picked(index)
        ? undefined
        : {
            kind,
            url: `/c/${viewerCharId}/challenge/approach-pick?effect=${effect}&roll=${roll}&index=${index}`,
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
    // Setup: one die down a face; a die already on the worst face isn't offered.
    if (pendingKind === 'lower_face') {
      const tapper = tap('face-change', 'face', 'Lower this die one face')
      return (index: number) => (session.tweakableDie(ch, index, roll) ? tapper(index) : undefined)
    }
    // Perfect choice: one die to its top face; a die already there isn't offered.
    if (pendingKind === 'max_face') {
      const tapper = tap('face-change', 'face', 'Set this die to its top face')
      return (index: number) => (session.tweakableDie(ch, index, roll) ? tapper(index) : undefined)
    }
    if (pendingKind === 'lower_raise') {
      const lowering = approach!.step === 'first'
      const tapper = tap('face-change', 'face', lowering ? 'Lower this die one face' : 'Raise this die one face')
      return (index: number) => (session.tweakableDie(ch, index, roll) ? tapper(index) : undefined)
    }
    // Perfect choice: discard one die, then copy another (the discarded one is already spent).
    if (pendingKind === 'discard_double') {
      return approach!.step === 'first'
        ? tap('discard', 'discard', 'Discard this die')
        : tap('face-change', 'copy', 'Copy this die')
    }
    return rerollAction(roll)
  }
  return (
    <div class="challenge">
      <div class="challenge-title-row">
        <div class="challenge-title-main">
          <h3 class="challenge-description">
            {attack ? (
              <>
                <b>{rollerName}</b> attacks <b>{attack.enemyName}</b>
                {ch.description && ` — ${ch.description}`}
              </>
            ) : (
              <>
                <b>{rollerName}</b> attempts to {ch.description || 'the challenge'}
              </>
            )}
          </h3>
          <div class="challenge-head">
            {attack ? (
              am?.tier && (
                <span class={!ch.resolution && !am.tier.miss ? 'result' : am.wounds > 0 ? 'result success' : 'result failure'}>
                  {am.tier.miss ? 'Miss' : ch.resolution ? `${am.tier.label} · ${woundLabel(am.wounds)}` : am.tier.label}
                </span>
              )
            ) : (
              <>
                <span class={`stakes stakes-${ch.stakes}`}>{stakesLabel(ch.stakes)} stakes</span>
                {math.success !== null && (
                  <span class={math.success ? 'result success' : 'result failure'}>
                    {math.success ? 'Success' : 'Failure'}
                  </span>
                )}
              </>
            )}
            {degreeText(math.degrees) && <span class="challenge-degree">{degreeText(math.degrees)}</span>}
            {ch.closed && <span class="badge closed">Done</span>}
          </div>
        </div>
        {attack ? (
          <AttackTargets
            ch={ch}
            math={math}
            controls={role === 'gm' && !ch.closed ? <CircumstanceControls value={ch.circumstance} /> : undefined}
          />
        ) : (
          <DifficultyPanel
            math={math}
            tier={tier}
            controls={role === 'gm' && !ch.closed ? <CircumstanceControls value={ch.circumstance} /> : undefined}
          />
        )}
      </div>
      {/* One box when the GM skipped framing, two when they didn't. */}
      <div class={framingField ? 'challenge-numbers' : 'challenge-numbers solo'}>
        {framingField && (
          <RollBox
            kind={attack ? 'Hit' : 'Framing'}
            field={framingField}
            label={framingField.label}
            side={ch.framing}
            outcome={math.framing}
            faces={session.rules.challenges.faces}
            skillBonus={math.skillBonus}
            skillLabel={math.skillLabel}
            skillIcon={math.skillIcon}
            exertion={ch.exertionFraming}
            dieAction={dieAction('framing')}
            custom={ch.customFraming}
            supports={supportsOn('framing')}
            roll="framing"
            editUrl={editFor('framing')}
            attemptLabel={role !== 'player'}
            caption={attack ? <HitCaption math={math} /> : <FramingCaption math={math} />}
            extras={hitExtras}
          />
        )}
        <RollBox
          kind={attack ? 'Damage' : 'Resolution'}
          field={resolutionField}
          label={resolutionField?.label ?? ch.resolutionAbility}
          side={damageSide}
          outcome={math.resolution}
          faces={session.rules.challenges.faces}
          skillBonus={math.skillBonus}
          skillLabel={math.skillLabel}
          skillIcon={math.skillIcon}
          exertion={ch.exertionResolution}
          framingBonus={attack ? undefined : math.rungBonus}
          extras={damageExtras}
          note={
            attack && am?.tier?.miss ? (
              <p class="attack-miss-note">Missed — no damage</p>
            ) : attack && !ch.resolution ? (
              <p class="attack-miss-note">{ch.framing ? 'Rolled once the hit is settled' : 'Rolled after the hit'}</p>
            ) : undefined
          }
          dieAction={dieAction('resolution')}
          custom={ch.customResolution}
          supports={supportsOn('resolution')}
          roll="resolution"
          editUrl={editFor('resolution')}
          attemptLabel={role !== 'player'}
          caption={attack ? <WoundCaption math={math} pool={attack.pool} /> : <ResolutionCaption math={math} />}
        />
      </div>
      <ApproachDie
        session={session}
        ch={ch}
        acting={acting}
        debug={role === 'gm' && rolled && !ch.closed}
        charId={viewerCharId}
      />
      {role !== 'player' && <ChallengeAbilities session={session} ch={ch} />}
      {isViewerTurn && !rolled && <ChallengeSetupControls session={session} ch={ch} charId={viewerCharId!} />}
      {acting && <ExertionControls session={session} ch={ch} charId={viewerCharId!} />}
      {acting && step === 'hit' && !am?.tier?.miss && (
        <div class="attack-next">
          <button
            type="button"
            class="primary"
            hx-post={`/c/${viewerCharId}/challenge/roll-damage`}
            hx-swap="none"
            disabled={ch.approachPicksLeft > 0 || undefined}
            title={ch.approachPicksLeft > 0 ? 'Finish the approach effect first' : undefined}
          >
            Done with the hit — roll damage
          </button>
          <p class="muted">The hit is locked once the damage is rolled.</p>
        </div>
      )}
      <SupportPanel session={session} ch={ch} role={role} viewerCharId={viewerCharId} />
      {role === 'gm' && rolled && !ch.closed && (!attack || step === 'damage' || am?.tier?.miss) && (
        <button type="button" class="primary" hx-post="/gm/challenge/done" hx-swap="none">
          {attack ? `Attack done${am && am.wounds > 0 ? ` — take ${am.wounds} ${poolLabel(attack.pool)} off ${attack.enemyName}` : ''}` : 'Challenge done'}
        </button>
      )}
    </div>
  )
}

/**
 * Support (user-designed): other players helping the one rolling. Everyone sees who is supporting
 * and what their die added. The **GM** adds a helper from a list of the other finished characters
 * and can take one off again (✕). A **supporter** — once the dice are in — is prompted to spend a
 * point of stamina or willpower (off their own sheet: the app deducts nothing) and roll one die of
 * an ability of their choice onto the framing or the resolution; it goes into that check's
 * breakdown under their name. One die per supporter.
 */
function SupportPanel(props: { session: Session; ch: Challenge; role: 'gm' | 'player' | 'table'; viewerCharId?: string }) {
  const { session, ch, role, viewerCharId } = props
  const gm = role === 'gm' && !ch.closed
  const name = (id: string) => session.characters.get(id)?.name ?? '?'
  const mine = ch.supporters.find((sp) => sp.charId === viewerCharId)
  const candidates = gm
    ? [...session.characters.values()].filter(
        (c) => c.status === 'active' && c.id !== ch.charId && !ch.supporters.some((sp) => sp.charId === c.id),
      )
    : []
  if (!ch.supporters.length && !candidates.length) return null
  const abilityLabel = (id: string | null) => (id ? session.rules.fields.get(id)?.label ?? id : '')
  const rolled = !!ch.resolution
  return (
    <div class="support">
      {ch.supporters.length > 0 && (
        <ul class="support-list">
          {ch.supporters.map((sp) => (
            <li>
              <b>{name(sp.charId)}</b> supports
              {sp.die ? (
                <span class="support-result">
                  {' '}
                  — {signed(sp.die.value)} on {sp.roll} ({abilityLabel(sp.ability)})
                </span>
              ) : (
                <span class="muted"> — {rolled && !ch.closed ? 'deciding…' : ch.closed ? 'did not roll' : 'waits for the roll'}</span>
              )}
              {gm && (
                <button
                  type="button"
                  class="support-remove"
                  hx-post={`/gm/challenge/supporter/remove?char=${sp.charId}`}
                  hx-swap="none"
                  title={`Take ${name(sp.charId)} off as a supporter${sp.die ? ' (and their die)' : ''}`}
                >
                  ✕
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {gm && candidates.length > 0 && (
        <form class="support-add" hx-post="/gm/challenge/supporter/add" hx-swap="none">
          <select name="charId" aria-label="Player to add as a supporter" required>
            <option value="">Add a supporter…</option>
            {candidates.map((c) => (
              <option value={c.id}>{c.name}</option>
            ))}
          </select>
          <button type="submit" class="small">
            Add
          </button>
        </form>
      )}
      {mine && !mine.die && !ch.closed && viewerCharId && (
        <SupportRoll session={session} ch={ch} charId={viewerCharId} rolled={rolled} />
      )}
    </div>
  )
}

/**
 * The supporter's own prompt: before the dice, a note to wait; after, pick an ability (their
 * framing/resolution abilities' match first) and press the check the die goes to.
 */
function SupportRoll(props: { session: Session; ch: Challenge; charId: string; rolled: boolean }) {
  const { session, ch, charId } = props
  const char = session.characters.get(charId)
  if (!char) return null
  const rollerName = (ch.charId ? session.characters.get(ch.charId)?.name : null) ?? 'The player'
  if (!props.rolled) {
    return <p class="support-prompt muted">You are supporting {rollerName}. Once the dice are in you can add one of yours.</p>
  }
  const abilities = [...session.rules.fields.values()].filter((f): f is NumberField => isBaseField(f) && !f.trained)
  return (
    <form class="support-roll" hx-post={`/c/${charId}/challenge/support`} hx-swap="none">
      <p class="support-prompt">
        Support {rollerName}: spend <b>1 stamina or willpower</b> (take it off your sheet), then roll one die of an
        ability onto a check.
      </p>
      <select name="ability" aria-label="Ability to roll">
        {abilities.map((f) => (
          <option value={f.id} selected={f.id === ch.resolutionAbility || undefined}>
            {f.label} ({String(session.valueOf(char, f))})
          </option>
        ))}
      </select>
      <div class="support-buttons">
        {session.rollsInPlay(ch).includes('framing') && (
          <button type="submit" name="roll" value="framing" class="small">
            Roll support for {ch.attack ? 'the hit' : 'framing'}
          </button>
        )}
        {session.rollsInPlay(ch).includes('resolution') && (
          <button type="submit" name="roll" value="resolution" class="primary">
            Roll support for {ch.attack ? 'the damage' : 'resolution'}
          </button>
        )}
      </div>
    </form>
  )
}

// ---- group task ---------------------------------------------------------------

/**
 * One participant's part of a group task: their name and result, then their framing and
 * resolution boxes — the same RollBox a challenge uses. Before the dice, the participant picks a
 * skill and rolls; after, they get the usual exertion (+1 or a reroll). No approach, no support.
 */
function GroupMember(props: { session: Session; g: GroupTask; ch: Challenge; role: 'gm' | 'player' | 'table'; viewerCharId?: string }) {
  const { session, g, ch, role, viewerCharId } = props
  const math = session.challengeMath(ch)
  const name = (ch.charId ? session.characters.get(ch.charId)?.name : null) ?? '?'
  const mine = role === 'player' && ch.charId === viewerCharId
  const rolled = !!ch.resolution
  const acting = mine && rolled && !ch.closed
  const base = `/c/${viewerCharId}/group`
  const field = (id: string | null) => (id ? (session.rules.fields.get(id) as NumberField | undefined) : undefined)
  const exertion = session.availableExertion(ch)
  const rerollAction = (roll: 'framing' | 'resolution') =>
    acting && ch.exertionRerollArmed && exertion > 0
      ? (index: number): DieAction => ({ kind: 'reroll', url: `${base}/reroll?roll=${roll}&index=${index}`, title: 'Reroll with exertion' })
      : undefined
  const skills = skillsFor(session, ch.charId)
  const margin = math.resolution?.difference
  const box = (roll: 'framing' | 'resolution') => {
    const f = field(roll === 'framing' ? g.framingAbility : g.resolutionAbility)
    return (
      <RollBox
        kind={roll === 'framing' ? 'Framing' : 'Resolution'}
        field={f}
        label={f?.label ?? ''}
        side={ch[roll]}
        outcome={roll === 'framing' ? math.framing : math.resolution}
        faces={session.rules.challenges.faces}
        skillBonus={math.skillBonus}
        skillLabel={math.skillLabel}
        skillIcon={math.skillIcon}
        exertion={roll === 'framing' ? ch.exertionFraming : ch.exertionResolution}
        framingBonus={roll === 'resolution' ? math.rungBonus : undefined}
        dieAction={rerollAction(roll)}
        caption={roll === 'framing' ? <FramingCaption math={math} /> : <ResolutionCaption math={math} />}
        custom={0}
        roll={roll}
      />
    )
  }
  return (
    <div class={`group-member ${math.success === null ? '' : math.success ? 'success' : 'failure'}`}>
      <div class="group-member-head">
        <b>{name}</b>
        {margin !== undefined ? (
          <span class={math.success ? 'result success' : 'result failure'}>
            {math.success ? 'Success' : 'Failure'} {margin >= 0 ? `+${margin}` : margin}
          </span>
        ) : (
          <span class="muted">{ch.closed ? 'did not roll' : 'to roll'}</span>
        )}
      </div>
      <div class={g.framingAbility ? 'challenge-numbers' : 'challenge-numbers solo'}>
        {g.framingAbility && box('framing')}
        {box('resolution')}
      </div>
      {mine && !rolled && !ch.closed && (
        <div class="challenge-setup group-setup">
          {skills.length > 0 && (
            <label class="skill-pick">
              Skill
              <select name="skill" hx-post={`${base}/setup`} hx-trigger="change" hx-swap="none">
                <option value="">None</option>
                {skills.map((f) => (
                  <option value={f.id} selected={ch.skill === f.id || undefined}>
                    {f.label}
                  </option>
                ))}
              </select>
            </label>
          )}
          <button type="button" class="primary" hx-post={`${base}/roll`} hx-swap="none">
            {g.framingAbility ? 'Roll framing and resolution' : 'Roll'}
          </button>
        </div>
      )}
      {acting && <ExertionControls session={session} ch={ch} charId={viewerCharId!} base={base} />}
    </div>
  )
}

/**
 * The group-task section (user-designed): the GM's "Start group task" button, then the current
 * task — its difficulty once, every participant's part in turn, and at the very bottom the
 * **total**: everyone's resolution margins added up. Its own swap target on all three screens; a
 * player sees it only when they take part (they see everyone's rolls in it), until it is completed.
 */
export function GroupTaskBoard(props: { session: Session; role: 'gm' | 'player' | 'table'; viewerCharId?: string; oob?: boolean }) {
  const { session, role, viewerCharId } = props
  const current = session.currentGroupTask()
  // Once the GM completes it, it leaves the players' screens (they see only what is still going on).
  const involved = !!current && !current.closed && current.members.some((m) => m.charId === viewerCharId)
  const g = role === 'player' && !involved ? null : current
  const tier = g ? session.rules.challenges.difficulties.find((d) => d.value === g.difficulty)?.label ?? null : null
  const total = g ? session.groupTotal(g) : null
  return (
    <section id="group-board" class="group-board" hx-swap-oob={oobAttr(props.oob)}>
      {role === 'gm' && (
        <button type="button" class="small" onclick="document.getElementById('group-dialog').showModal()">
          Start group task
        </button>
      )}
      {g && total && (
        <div class="challenge group-task">
          <div class="challenge-title-row">
            <div class="challenge-title-main">
              <h3 class="challenge-description">Group task: {g.description || 'everyone together'}</h3>
              <div class="challenge-head">
                <span class={`stakes stakes-${g.stakes}`}>{stakesLabel(g.stakes)} stakes</span>
                {g.closed && <span class="badge closed">Done</span>}
              </div>
            </div>
            <DifficultyPanel math={session.challengeMath(g.members[0]!)} tier={tier} />
          </div>
          {g.members.map((ch) => (
            <GroupMember session={session} g={g} ch={ch} role={role} viewerCharId={viewerCharId} />
          ))}
          <div class={`group-total ${total.sum > 0 ? 'help' : total.sum < 0 ? 'hinder' : 'even'}`}>
            <span class="group-total-label">Total</span>
            <span class="group-total-value">{total.sum > 0 ? `+${total.sum}` : total.sum}</span>
            <span class="muted">
              {total.rolled} of {total.total} rolled
            </span>
          </div>
          {role === 'gm' && !g.closed && (
            <button type="button" class="primary" hx-post="/gm/group/done" hx-swap="none">
              Complete group challenge
            </button>
          )}
        </div>
      )}
    </section>
  )
}

/** Clears the group dialog after a task starts, then closes it. */
const AFTER_GROUP = [
  'if (!event.detail.successful) return;',
  'const d = Alpine.$data(this);',
  "Object.assign(d, { description: '', stakes: 'normal', diff: '', diffValue: '', framingAbility: '', resolutionAbility: '', charIds: [] });",
  "this.closest('dialog').close()",
].join(' ')

/**
 * GM-only dialog for a group task: description, stakes, the difficulty — picked off the ladder,
 * then **nudged ±1** before anyone is invited — the framing (optional) and resolution abilities,
 * and **who joins** (any number of players; the count is shown). One POST starts it.
 */
export function GroupTaskDialog(props: { session: Session }) {
  const { session } = props
  const { rules } = session
  const abilities = [...rules.fields.values()].filter((f): f is NumberField => isBaseField(f) && !f.trained)
  const difficulties = rules.challenges.difficulties
  const characters = [...session.characters.values()].filter((c) => c.status === 'active')
  const state = {
    description: '',
    stakes: 'normal',
    diff: '',
    diffValue: '',
    framingAbility: '',
    resolutionAbility: '',
    charIds: [] as string[],
    abilities: abilities.map((f) => ({ id: f.id, label: f.label, color: f.color ?? '' })),
    difficulties: difficulties.map((d) => ({ id: d.id, label: d.label, value: d.value })),
  }
  return (
    <dialog id="group-dialog" class="challenge-dialog">
      <form hx-post="/gm/group/start" hx-swap="none" x-data={JSON.stringify(state)} hx-on--after-request={AFTER_GROUP}>
        <header class="dialog-head">
          <h3>New group task</h3>
          <button type="button" class="small" x-on:click="$el.closest('dialog').close()">
            Close
          </button>
        </header>
        <label class="challenge-description-field">
          <span>What is the task? (optional)</span>
          <input name="description" x-model="description" placeholder="e.g. Haul the cart up the pass" maxlength={200} autocomplete="off" />
        </label>
        <div class="stakes-row">
          {(['low', 'normal', 'high'] as const).map((st) => (
            <button type="button" class={`stakes-btn stakes-${st}`} x-bind:class={`{ on: stakes === '${st}' }`} x-on:click={`stakes = '${st}'`}>
              {stakesLabel(st)}
            </button>
          ))}
        </div>
        <DifficultyPicker difficulties={difficulties} />
        <div class="group-nudge" x-show="diffValue !== ''" x-cloak>
          <span>Adjust</span>
          <button type="button" class="circumstance-step" x-on:click="diffValue = Number(diffValue) - 1">
            {'\u2212'}1
          </button>
          <button type="button" class="circumstance-step" x-on:click="diffValue = Number(diffValue) + 1">
            +1
          </button>
        </div>
        <AbilityPicker
          title="Framing ability (optional)"
          hint="Each player's framing sets up their own resolution, as in a challenge."
          abilityVar="framingAbility"
          abilities={abilities}
          skippable
        />
        <AbilityPicker title="Resolution ability" hint="Every player rolls this against the same difficulty." abilityVar="resolutionAbility" abilities={abilities} />
        <section class="side-pick player-pick">
          <h4>
            Who joins <span class="muted" x-text="'(' + charIds.length + ' player' + (charIds.length === 1 ? '' : 's') + ')'"></span>
          </h4>
          {characters.length === 0 ? (
            <p class="muted">No finished characters yet.</p>
          ) : (
            <div class="pick-col">
              {characters.map((c) => (
                <button
                  type="button"
                  class="pick-btn"
                  x-bind:class={`{ on: charIds.includes('${c.id}') }`}
                  x-on:click={`charIds = charIds.includes('${c.id}') ? charIds.filter((x) => x !== '${c.id}') : [...charIds, '${c.id}']`}
                >
                  <span class="label">{c.name}</span>
                </button>
              ))}
            </div>
          )}
        </section>
        <input type="hidden" name="stakes" x-model="stakes" />
        <input type="hidden" name="difficulty" x-model="diffValue" />
        <input type="hidden" name="framing_ability" x-model="framingAbility" />
        <input type="hidden" name="resolution_ability" x-model="resolutionAbility" />
        <input type="hidden" name="char_ids" x-bind:value="charIds.join(',')" />
        <button type="submit" class="primary" x-bind:disabled="!(diffValue !== '' && resolutionAbility && charIds.length)">
          Start group task
        </button>
      </form>
    </dialog>
  )
}

/** Past challenges (everything except the current one), most recent first. */
/** A past challenge, or a solo roll the GM showed the table — the history log mixes both. */
type LogEntry =
  | { kind: 'challenge'; ch: Challenge }
  | { kind: 'solo'; solo: SoloRoll }
  | { kind: 'opposition'; opp: Opposition }
  | { kind: 'group'; g: GroupTask }
  | { kind: 'enemyAttack'; attack: EnemyAttack }

/** " and succeeds with +4" / " and fails with -2" — how every history line ends. */
const verdict = (success: boolean, margin: number) =>
  ` and ${success ? 'succeeds' : 'fails'} with ${margin >= 0 ? `+${margin}` : margin}`

/**
 * A public solo roll's line (user-specified format): "Ogre notices you (easy) 4 and succeeds with
 * +4" — the GM's description, the tier it was picked from (left out once a nudge moved the number
 * off it), the opposition number, and the margin. No description reads "Solo roll".
 */
function SoloLogLine(props: { session: Session; solo: SoloRoll }) {
  const { solo } = props
  const outcome = props.session.soloOutcome(solo)
  return (
    <li class={outcome.success ? 'success' : 'failure'}>
      <b>{solo.description || 'Solo roll'}</b>
      {solo.tier && ` (${solo.tier.toLowerCase()})`} {solo.difficulty}
      {verdict(outcome.success, outcome.difference)}
    </li>
  )
}

function ChallengeLog(props: { session: Session; entries: LogEntry[] }) {
  const { session, entries } = props
  if (entries.length === 0) return null
  return (
    <ul class="challenge-log">
      {entries.map((entry) => {
        if (entry.kind === 'solo') return <SoloLogLine session={session} solo={entry.solo} />
        if (entry.kind === 'enemyAttack') return <EnemyAttackLogLine attack={entry.attack} />
        if (entry.kind === 'challenge' && entry.ch.attack) return <AttackLogLine session={session} ch={entry.ch} />
        if (entry.kind === 'group') {
          // "Group task: haul the cart (challenging) 7 — Mara +3, Jorik -2 · total +1"
          const { g } = entry
          const tier = session.rules.challenges.difficulties.find((d) => d.value === g.difficulty)?.label
          const total = session.groupTotal(g)
          const results = g.members.map((m) => {
            const who = (m.charId ? session.characters.get(m.charId)?.name : null) ?? '?'
            const r = session.challengeMath(m).resolution
            return r ? `${who} ${r.difference >= 0 ? `+${r.difference}` : r.difference}` : `${who} did not roll`
          })
          return (
            <li class={total.sum > 0 ? 'success' : total.sum < 0 ? 'failure' : undefined}>
              <b>Group task</b>: {g.description || 'everyone together'}
              {tier && ` (${tier.toLowerCase()})`} {g.difficulty} — {results.join(', ')} · total{' '}
              {total.sum >= 0 ? `+${total.sum}` : total.sum}
            </li>
          )
        }
        if (entry.kind === 'opposition') {
          // "Mara vs Guard: arm wrestle — Mara wins by 1 degree", with the board's own verdict.
          const { opp } = entry
          return (
            <li class="opposition-line">
              <b>{opp.a.name}</b> vs <b>{opp.b.name}</b>: {opp.description} — {oppositionStatus(session, opp)}
            </li>
          )
        }
        const { ch } = entry
        const math = session.challengeMath(ch)
        // "Mara attempts to scale the wall (challenging) 7 and succeeds with +4" (user-specified).
        // The tier is named from the GM's own difficulty, the number is the effective target the
        // resolution had to reach, and the margin is the resolution's, measured against it.
        const tier = session.rules.challenges.difficulties.find((d) => d.value === ch.difficulty)?.label
        const name = (ch.charId ? session.characters.get(ch.charId)?.name : null) ?? 'Someone'
        const margin = math.resolution?.difference
        return (
          <li class={math.success === null ? undefined : math.success ? 'success' : 'failure'}>
            <b>{name}</b> attempts to {ch.description || 'the challenge'}
            {tier && ` (${tier.toLowerCase()})`} {math.target}
            {margin !== undefined && verdict(!!math.success, margin)}
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
 * One ability column of the setup dialog: a big indicator of what is picked above a list of the
 * sheet's abilities. Picking is Alpine state on the form (the var named by `abilityVar`).
 */
function AbilityPicker(props: {
  title: string
  hint: string
  abilityVar: string
  abilities: NumberField[]
  /** Offers a "No framing" button that clears the pick; only the framing roll is skippable. */
  skippable?: boolean
}) {
  const { title, abilityVar, abilities } = props
  const picked = `(abilities.find((a) => a.id === ${abilityVar}) || {})`
  const empty = props.skippable ? 'No framing roll' : 'Pick an ability'
  return (
    <section class="side-pick">
      <h4>{title}</h4>
      <p class="side-hint">{props.hint}</p>
      <div class="big-indicator">
        {/* Every icon is rendered and only the picked one is shown, so no SVG is needed client-side. */}
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
          <span x-text={`${picked}.label || '${empty}'`}>{empty}</span>
        </span>
      </div>
      <div class="pick-col">
        {props.skippable && (
          <button
            type="button"
            class="pick-btn skip-btn"
            x-bind:class={`{ on: !${abilityVar} }`}
            x-on:click={`${abilityVar} = ''`}
          >
            <span class="label">No framing — resolution only</span>
          </button>
        )}
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
    </section>
  )
}

/**
 * The challenge's one difficulty: a tier off the rules.yaml ladder, shown as its number. The GM
 * nudges it afterwards with the board's circumstance stepper rather than here, so there is one
 * place a number moves and everyone sees why.
 */
function DifficultyPicker(props: { difficulties: { id: string; label: string; value: number }[] }) {
  return (
    <section class="side-pick">
      <h4>Difficulty</h4>
      <p class="side-hint">One number for the whole challenge — both rolls go against it.</p>
      <div class="big-indicator">
        <span class="bi-value">
          <span x-text="diffValue === '' ? '–' : diffValue">–</span>
          <span
            class="bi-tier"
            x-cloak
            x-show="diff"
            x-text="'(' + ((difficulties.find((d) => d.id === diff) || {}).label || '') + ')'"
          ></span>
        </span>
      </div>
      <div class="pick-col">
        {props.difficulties.map((d) => (
          <button
            type="button"
            class="pick-btn diff-btn"
            x-bind:class={`{ on: diff === '${d.id}' }`}
            x-on:click={`diff = '${d.id}'; diffValue = ${d.value}`}
          >
            <span class="label">{d.label}</span>
            <span class="diff-value">{d.value}</span>
          </button>
        ))}
      </div>
    </section>
  )
}

/** Clears the dialog's picks (Alpine state) after a challenge is started, then closes it. */
const AFTER_START = [
  'if (!event.detail.successful) return;',
  'const d = Alpine.$data(this);',
  "Object.assign(d, { description: '', stakes: 'normal', diff: '', diffValue: '',",
  "  framingAbility: '', resolutionAbility: '', charId: '' });",
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
    diff: '',
    diffValue: '',
    framingAbility: '',
    resolutionAbility: '',
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

        {/* Optional (user decision): a quick challenge at the table needs no name. */}
        <label class="challenge-description-field">
          <span>What is the challenge? (optional)</span>
          <input
            name="description"
            x-model="description"
            placeholder="e.g. Climb the cliff before the tide turns"
            maxlength={200}
            autocomplete="off"
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

        <DifficultyPicker difficulties={difficulties} />
        <AbilityPicker
          title="Framing ability (optional)"
          hint="How far it lands from the difficulty sets the resolution's target. Skip it and the resolution check is the whole challenge."
          abilityVar="framingAbility"
          abilities={abilities}
          skippable
        />
        <AbilityPicker
          title="Resolution ability"
          hint="This is the one that decides it. Both checks are rolled together."
          abilityVar="resolutionAbility"
          abilities={abilities}
        />

        <section class="side-pick player-pick">
          <h4>Who rolls</h4>
          <ChallengePlayerPicker session={session} />
        </section>

        <input type="hidden" name="stakes" x-model="stakes" />
        <input type="hidden" name="difficulty" x-model="diffValue" />
        <input type="hidden" name="framing_ability" x-model="framingAbility" />
        <input type="hidden" name="resolution_ability" x-model="resolutionAbility" />
        <input type="hidden" name="char_id" x-model="charId" />
        <button
          type="submit"
          class="primary"
          x-bind:disabled="!(diff && resolutionAbility && charId)"
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
          <Equation
            rows={[
              solo.roll.dice.map((d, i) => (
                <Die value={d} faceId={solo.roll.faces?.[i]} faces={session.rules.challenges.faces} />
              )),
            ]}
            result={
              <span class="equation-result">
                <span class="solo-sum">{outcome.sum}</span>
                <span class="solo-diff">{signed(outcome.difference)}</span>
              </span>
            }
          />
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
  // No player is ever part of a solo roll, so players never see one; a public one goes to the table.
  const visible = solo && (role === 'gm' || (role === 'table' && solo.visibility === 'public'))
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

/** Who is looking at an opposition roll, and so what they may see and do on it. */
type OppViewer = { session: Session; opp: Opposition; role: 'gm' | 'player' | 'table'; viewerCharId?: string }

/** Whether this viewer is the player on `side`, and whether they (or the GM) act for it now. */
function oppActing(v: OppViewer, side: OppositionSide) {
  const one = v.opp[side]
  const phase = v.session.oppositionPhase(v.opp)
  const mine = !!one.charId && one.charId === v.viewerCharId
  // The GM can act for any side (an NPC has nobody else); nobody acts once it is completed.
  const forSide = !v.opp.closed && (mine || v.role === 'gm')
  return { mine, phase, commits: phase === 'committing' && !one.ready && forSide, forSide }
}

/**
 * A contestant's name cell: the name, NPC / Ready badges, and — while it is hidden from this
 * viewer — the note that something has been committed. Marked `won` / `lost` once it is over.
 */
function OppName(props: OppViewer & { side: OppositionSide }) {
  const { session, opp, side } = props
  const one = opp[side]
  const outcome = session.oppositionOutcome(opp)
  const open = session.oppositionCommitVisible(opp, side, props.role, props.viewerCharId)
  const hidden = !open && (one.exertionFraming + one.exertionResolution > 0 || !!one.skill)
  const result = outcome?.winner ? (outcome.winner === side ? 'won' : 'lost') : ''
  return (
    <div class={`opp-name-cell ${result}`}>
      <div class="opp-name">
        <span>{one.name}</span>
        {!one.charId && <span class="badge opp-npc">NPC</span>}
        {one.ready && session.oppositionPhase(opp) === 'committing' && <span class="badge opp-ready">Ready</span>}
      </div>
      {hidden && <p class="opp-hidden">Bonus committed — hidden until both are ready</p>}
    </div>
  )
}

/**
 * One contestant's check, framing or resolution — shown like a challenge's roll box: the dice,
 * then the committed skill and exertion, and on the resolution the **framing rung's bonus**, which
 * only exists once both sides have rolled (it comes off the framing margin against the other
 * side). The framing cell names the rung it landed on underneath, like a challenge's framing.
 */
function OppCheckCell(props: OppViewer & { side: OppositionSide; check: 'framing' | 'resolution' }) {
  const { session, opp, side, check } = props
  const one = opp[side]
  const outcome = session.oppositionOutcome(opp)
  const open = session.oppositionCommitVisible(opp, side, props.role, props.viewerCharId)
  const skill = one.charId ? session.oppositionSkillState(one) : null
  const rolled = one[check]
  const framing = check === 'framing'
  const abilityId = framing ? one.framingAbility : one.resolutionAbility
  const field = abilityId ? (session.rules.fields.get(abilityId) as NumberField | undefined) : undefined
  const rank = framing ? one.framingRank : one.resolutionRank
  const skillOn = session.oppositionSkillBonus(one) // the skill counts in full on both checks
  const exertionOn = framing ? one.exertionFraming : one.exertionResolution
  const rung = outcome?.rungs[side] ?? null
  const rungBonus = !framing ? (rung?.resolutionBonus ?? 0) : 0
  const own = session.oppositionSum(one, check)
  const sum = outcome ? (framing ? outcome.framing : outcome.resolution)[side === 'a' ? 'aSum' : 'bSum'] : own
  const takesIt = outcome && (framing ? outcome.framing : outcome.resolution).winner === side
  const bonuses: Child[] = []
  if (open && skillOn) bonuses.push(bonusChip(skillOn, skill?.label ?? 'Skill', skill?.icon ?? undefined, 'skill'))
  if (open && exertionOn) bonuses.push(bonusChip(exertionOn, 'Exertion', undefined, 'exertion'))
  if (rungBonus) bonuses.push(bonusChip(rungBonus, 'Framing', undefined, rungBonus > 0 ? 'help' : 'hinder'))
  const tone = rung && (rung.resolutionBonus > 0 ? 'help' : rung.resolutionBonus < 0 || rung.degrees < 0 ? 'hinder' : 'even')
  return (
    <div
      class={`opp-check ${takesIt ? 'takes-it' : ''}`}
      style={field?.color ? `--field-color: ${field.color}; --field-ink: ${field.ink}` : undefined}
    >
      <div class="opp-check-head">
        <span class="opp-check-label">{framing ? 'Framing' : 'Resolution'}</span>
        <IconChip icon={field?.icon} />
        <span class="opp-ability">{field?.label ?? (rank !== null ? `Rank ${rank}` : '\u2014')}</span>
      </div>
      {rolled ? (
        <Equation
          rows={[
            rolled.dice.map((d, i) => (
              <Die value={d} faceId={rolled.faces?.[i]} faces={session.rules.challenges.faces} />
            )),
            bonuses,
          ]}
          result={
            <span class="opp-result">
              <span class="opp-sum">{sum}</span>
              {/* The winner's resolution shows by how much it beat the other side's. */}
              {!framing && outcome?.resolution.winner === side && (
                <span class="opp-diff">+{Math.abs(outcome.resolution.margin)}</span>
              )}
            </span>
          }
        />
      ) : (
        <div class="opp-waiting">
          {open && skillOn + exertionOn !== 0 ? `committed ${signed(skillOn + exertionOn)}` : '\u2014'}
        </div>
      )}
      {framing && rung && (
        <div class={`roll-caption roll-caption-${tone}`}>
          <span class="roll-caption-title">{rung.label}</span>
          {rung.resolutionBonus !== 0 && (
            <span class="roll-caption-sub">({signed(rung.resolutionBonus)} bonus to resolution)</span>
          )}
        </div>
      )}
      {oppActing(props, side).commits && <CommitControls session={session} opp={opp} one={one} check={check} />}
    </div>
  )
}

/** Under a contestant: the skill split, the skill pick, and Ready / Roll for whoever acts for it. */
function OppFooter(props: OppViewer & { side: OppositionSide }) {
  const { session, opp, side } = props
  const one = opp[side]
  const { phase, commits, forSide } = oppActing(props, side)
  return (
    <div class="opp-footer">
      {commits && one.charId && <SkillPick session={session} opp={opp} one={one} />}
      {phase === 'committing' && forSide && (
        <button
          type="button"
          class={one.ready ? 'small' : 'primary'}
          hx-post={`/gm/opposition/ready?side=${side}&to=${one.ready ? '0' : '1'}`}
          hx-swap="none"
        >
          {one.ready ? 'Not ready after all' : 'Ready'}
        </button>
      )}
      {phase === 'rolling' && !one.resolution && forSide && (
        <button type="button" class="primary" hx-post={`/gm/opposition/roll?side=${side}`} hx-swap="none">
          Roll
        </button>
      )}
      {phase === 'rolling' && one.resolution && <p class="muted">Rolled — waiting for the other side</p>}
    </div>
  )
}

/**
 * A player's view of the contest: **their own side only** (user decision) — name, framing,
 * resolution, and their controls. The other side's checks are not shown to them at all.
 */
function OppOwnSide(props: OppViewer & { side: OppositionSide }) {
  const result = props.session.oppositionOutcome(props.opp)?.winner
  return (
    <div class={`opp-side ${result ? (result === props.side ? 'won' : 'lost') : ''}`}>
      <OppName {...props} />
      <OppCheckCell {...props} check="framing" />
      <OppCheckCell {...props} check="resolution" />
      <OppFooter {...props} />
    </div>
  )
}

/**
 * Both sides **side by side in a 2 × 2 grid** (user decision, for the table; the GM gets the same):
 * one column per contestant, framing in the top row and resolution below it, so the two checks
 * being compared always sit next to each other. Names head the columns; controls go underneath.
 */
function OppGrid(props: OppViewer) {
  const cell = (side: OppositionSide, check: 'framing' | 'resolution') => (
    <OppCheckCell {...props} side={side} check={check} />
  )
  return (
    <div class="opp-grid">
      <OppName {...props} side="a" />
      <OppName {...props} side="b" />
      {cell('a', 'framing')}
      {cell('b', 'framing')}
      {cell('a', 'resolution')}
      {cell('b', 'resolution')}
      <OppFooter {...props} side="a" />
      <OppFooter {...props} side="b" />
    </div>
  )
}

/** Stamina/willpower burned onto one check. (A declared skill needs no split: it counts on both.) */
function CommitControls(props: {
  session: Session
  opp: Opposition
  one: Contestant
  check: 'framing' | 'resolution'
}) {
  const { session, opp, one, check } = props
  if (!one.charId) return null // an NPC commits nothing
  const char = session.characters.get(one.charId)
  if (!char) return null
  const side: OppositionSide = opp.a.charId === one.charId ? 'a' : 'b'
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
    </div>
  )
}

/** Declares which trained skill this side is committing (its rank then counts on both checks). */
function SkillPick(props: { session: Session; opp: Opposition; one: Contestant }) {
  const { session, one } = props
  const skills = skillsFor(session, one.charId)
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
  if (opp.closed && phase !== 'done') return 'Completed by the GM before both sides rolled'
  if (phase === 'committing') {
    const waiting = [opp.a, opp.b].filter((o) => !o.ready).map((o) => o.name)
    return `Committing — waiting on ${waiting.join(' and ')}`
  }
  if (phase === 'rolling') {
    const waiting = [opp.a, opp.b].filter((o) => !o.resolution).map((o) => o.name)
    return waiting.length ? `Both ready — waiting for ${waiting.join(' and ')} to roll` : 'Rolling\u2026'
  }
  const outcome = session.oppositionOutcome(opp)!
  if (!outcome.winner) return 'Tie — the GM rules on it'
  const winner = outcome.winner === 'a' ? opp.a.name : opp.b.name
  const degrees = outcome.degrees === 0 ? 'by a hair' : `by ${outcome.degrees} degree${outcome.degrees > 1 ? 's' : ''}`
  const split = outcome.decidedBy === 'framing' ? ' (the resolution was level, so the framing decided)' : ''
  return `${winner} wins ${degrees}${split}`
}

/**
 * The opposition-roll section: the GM's "Start opposition roll" button and the contest itself.
 * Its own swap target, and mounted on all three screens. The GM and the table see every contest
 * as a 2 × 2 grid (OppGrid); a player sees it only when their character is one of the two sides,
 * and then **only their own side** (OppOwnSide) — never the other player's checks.
 */
export function OppositionBoard(props: {
  session: Session
  role: 'gm' | 'player' | 'table'
  viewerCharId?: string
  oob?: boolean
}) {
  const { session, role, viewerCharId } = props
  const current = session.currentOpposition()
  // A player sees the current contest only when their character is one of its two sides.
  // Once the GM completes it, it leaves the players' screens (they see only what is still going on).
  const involved =
    !!current && !current.closed && [current.a, current.b].some((o) => o.charId !== null && o.charId === viewerCharId)
  const opp = role === 'player' && !involved ? null : current
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
            {opp.closed && <span class="badge closed">Done</span>}
          </div>
          <p class="opp-status">{oppositionStatus(session, opp)}</p>
          {role === 'player' ? (
            // Only reachable when the viewer is in it (see `involved`), so `mine` is one side.
            <OppOwnSide
              session={session}
              opp={opp}
              role={role}
              viewerCharId={viewerCharId}
              side={opp.a.charId === viewerCharId ? 'a' : 'b'}
            />
          ) : (
            <OppGrid session={session} opp={opp} role={role} viewerCharId={viewerCharId} />
          )}
          {role === 'gm' && !opp.closed && (
            <button type="button" class="primary" hx-post="/gm/opposition/done" hx-swap="none">
              Complete opposition challenge
            </button>
          )}
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
  "  aKind: 'character', aChar: '', aFraming: '', aResolution: '', aName: '', aFramingRank: d.defRank, aResolutionRank: d.defRank,",
  "  bKind: 'character', bChar: '', bFraming: '', bResolution: '', bName: '', bFramingRank: d.defRank, bResolutionRank: d.defRank });",
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
        <h5>Framing ability</h5>
        {abilityCol(`${side}Framing`)}
        <h5>Resolution ability</h5>
        {abilityCol(`${side}Resolution`)}
      </div>

      <div x-show={`${kind} === 'npc'`} x-cloak>
        <input
          x-model={`${side}Name`}
          placeholder="NPC name, e.g. Gate guard"
          maxlength={40}
          autocomplete="off"
        />
        <h5>Framing rank</h5>
        {rankCol(`${side}FramingRank`)}
        <h5>Resolution rank</h5>
        {rankCol(`${side}ResolutionRank`)}
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
    aFraming: '',
    aResolution: '',
    aName: '',
    aFramingRank: def,
    aResolutionRank: def,
    bKind: 'character',
    bChar: '',
    bFraming: '',
    bResolution: '',
    bName: '',
    bFramingRank: def,
    bResolutionRank: def,
  }
  // A side is settled once it is a character with both abilities, or an NPC (ranks always have
  // a value, and the name falls back to "NPC" server-side).
  const ready = (p: 'a' | 'b') => `(${p}Kind === 'npc' ? true : (${p}Char && ${p}Framing && ${p}Resolution))`
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
            <input type="hidden" name={`${p}_framing`} x-model={`${p}Framing`} />
            <input type="hidden" name={`${p}_resolution`} x-model={`${p}Resolution`} />
            <input type="hidden" name={`${p}_name`} x-model={`${p}Name`} />
            <input type="hidden" name={`${p}_framing_rank`} x-model={`${p}FramingRank`} />
            <input type="hidden" name={`${p}_resolution_rank`} x-model={`${p}ResolutionRank`} />
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
  const current = session.currentChallenge()
  // A player sees only the current challenge, and only when it is theirs to roll (user decision);
  // the GM and the table see every one. The section stays mounted either way, so a live update
  // still has somewhere to land when a challenge is handed to this player.
  // A supporter is part of it too, so they see it (to roll their support die).
  // A closed one ("Challenge done") leaves their screen: players see only what is still going on.
  const involved =
    !!current &&
    !current.closed &&
    (current.charId === viewerCharId || current.supporters.some((sp) => sp.charId === viewerCharId))
  const ch = role === 'player' && !involved ? null : current
  // Past challenges (the current one is on the board above), every solo roll the GM has shown
  // the table, and finished earlier opposition rolls — newest first. Hiding a solo roll again
  // takes it back out.
  const history: LogEntry[] = [
    ...session.challenges.slice(0, -1).map((c) => ({ kind: 'challenge' as const, ch: c, seq: c.seq })),
    ...session.soloRolls.filter((s) => s.visibility === 'public').map((s) => ({ kind: 'solo' as const, solo: s, seq: s.seq })),
    // Finished contests before the current one (which is on its own board): once the next one
    // starts, this is where the table can still read how it went.
    ...session.oppositions
      .slice(0, -1)
      .filter((o) => session.oppositionPhase(o) === 'done')
      .map((o) => ({ kind: 'opposition' as const, opp: o, seq: o.seq })),
    // Enemies' attacks on players (a player's own attack is a challenge, above).
    ...session.enemyAttacks.map((a) => ({ kind: 'enemyAttack' as const, attack: a, seq: a.seq })),
    // Group tasks once the GM has closed them (or a newer one has taken the board).
    ...session.groupTasks
      .filter((g, i) => g.closed || i < session.groupTasks.length - 1)
      .map((g) => ({ kind: 'group' as const, g, seq: g.seq })),
  ].sort((a, b) => b.seq - a.seq)
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
        role !== 'player' && <p class="muted">No challenge yet.</p>
      )}
      {/* The history log is the table screen's alone (user decision): the GM reads it there. */}
      {role === 'table' && <ChallengeLog session={session} entries={history} />}
    </section>
  )
}
