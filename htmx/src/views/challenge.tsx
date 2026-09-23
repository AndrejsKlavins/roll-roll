// Public challenge board: the challenge's one difficulty with the skill and circumstance working
// under it, the framing and resolution rolls beside each other, and a history log of past
// challenges. Shared between /table (the shared screen), /gm (setup + oversight) and the player's
// own page (pick/roll controls) — role picks what's interactive.
import { raw } from 'hono/html'
import { abilityRankRange } from '../rules'
import type { ApproachEffect, ApproachWhen, FaceName, Icon, NumberField } from '../rules'
import type { Child } from 'hono/jsx'
import {
  APPROACH_DIE_SIDES,
  isBaseField,
  MAX_CIRCUMSTANCE,
  type Contestant,
  type Opposition,
  type OppositionSide,
  type SoloRoll,
  type Challenge,
  type ChallengeMath,
  type ChallengeSide,
  type DieMarker,
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

/**
 * The challenge's one difficulty, shown as the sum it actually is: the GM's number, less the
 * player's skill rank, plus the circumstance modifier — with the result in big type. Everyone
 * sees the working (user requirement); only the GM gets the stepper.
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
      {/* The skill is a bonus on the rolls (it shows beside the dice), so only the GM's
          circumstance moves this number — and then everyone sees the working. */}
      {math.circumstance !== 0 && (
        <p class="difficulty-calc">
          <span class="calc-part">{math.difficulty}</span>
          <span class={math.circumstance > 0 ? 'calc-part hinder' : 'calc-part help'}>
            {math.circumstance > 0 ? '+' : '−'} {Math.abs(math.circumstance)} circumstance
          </span>
          <span class="calc-part calc-total">= {math.target}</span>
        </p>
      )}
      {math.skillBonus > 0 && (
        <p class="difficulty-note">
          {math.skillLabel} {signed(math.skillBonus)} on every result
        </p>
      )}
      {props.controls}
    </div>
  )
}

/**
 * One of the two rolls: its ability, the number it goes against, its dice and (once they are in)
 * the sum and how far off the target it landed. The framing box carries the rung it landed on
 * below its number; the resolution box carries the final verdict.
 */
function RollBox(props: {
  field: NumberField | undefined
  label: string
  /** "Framing" / "Resolution" — which of the two this is, above the ability's name. */
  kind: string
  target: number
  /** What the framing rung did to this target, when it moved it. */
  targetShift?: number
  side: ChallengeSide | null
  outcome: SideOutcome | null
  faces: FaceName[]
  /** The declared skill's rank: a bonus on this result, shown beside the dice. */
  skillBonus: number
  exertion: number
  /** Set when the viewer may act on the dice here (exertion reroll, pending approach effect). */
  dieAction?: (index: number) => DieAction | undefined
  /** GM and table screens name the result; the player sees their own controls instead. */
  attemptLabel?: boolean
  note?: Child
  controls?: Child
}) {
  const { field, label, target, side, outcome } = props
  const cls = ['difficulty-box', outcome && (outcome.success ? 'success' : 'failure')].filter(Boolean).join(' ')
  return (
    <div class={cls} style={field?.color ? `--field-color: ${field.color}; --field-ink: ${field.ink}` : undefined}>
      <div class="roll-kind">{props.kind}</div>
      <div class="difficulty-label">
        <IconChip icon={field?.icon} />
        <span>{label}</span>
      </div>
      <div class="difficulty-target">
        {target}
        {!!props.targetShift && (
          <span
            class={props.targetShift > 0 ? 'circumstance hinder' : 'circumstance help'}
            title={`The framing ${props.targetShift > 0 ? 'raised' : 'lowered'} this target by ${Math.abs(
              props.targetShift,
            )}`}
          >
            {signed(props.targetShift)}
          </span>
        )}
      </div>
      {props.note}
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
            {props.skillBonus !== 0 && (
              <span class="skill-bonus" title="Skill bonus">
                {signed(props.skillBonus)}
              </span>
            )}
            {props.exertion !== 0 && <span class="exert-bonus">{signed(props.exertion)}</span>}
          </div>
          <div class="difficulty-sum">{outcome.sum}</div>
          <div class="difficulty-diff">{signed(outcome.difference)}</div>
          {props.controls}
        </div>
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
function ChallengeSetupControls(props: { session: Session; ch: Challenge; charId: string }) {
  const { session, ch, charId } = props
  const { rules } = session
  const skills = [...rules.fields.values()].filter((f): f is NumberField => f.type === 'number' && f.trained)
  return (
    <div class="challenge-player-setup">
      <div class="approach-pick">
        <span class="approach-legend">Approach (resolution roll)</span>
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
        {ch.framingAbility ? 'Roll framing and resolution' : 'Roll'}
      </button>
    </div>
  )
}

/**
 * The approach die: one plain d6 rolled with the **resolution** dice. When it counts follows the
 * approach's `when` (always / only while failing / the player's choice); what it does on that
 * face comes from `effects` in rules.yaml. Effects that need a die put the board in a pending
 * state and the resolution dice become tappable; the rest apply the moment Activate is pressed.
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
  // What this face is (the effect's own words, or a plain note for an approach with no effects).
  const note = effect
    ? effect.label
    : state.status === 'active'
      ? ch.approachActivated
        ? 'Activated'
        : state.approach.when === 'failure'
          ? 'In effect — the resolution is failing'
          : 'In effect'
      : state.status === 'skipped'
        ? 'Skipped — the resolution succeeded'
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
              ? 'Skipped — the resolution succeeded'
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
 * two-step effects (Tweak, Perfect choice) name the step they are on instead. Effects that need
 * no die never get here — they apply on Activate.
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
  return step === 'first' ? `${who} a die to discard it` : `${who} another die to copy it`
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
 * What the framing roll did to the resolution roll, in the ladder rung's own words — shown
 * between the two boxes on every screen. It is derived, so a reroll or a point of exertion on the
 * framing moves it (and the resolution's target) the moment it lands.
 */
function FramingResult(props: { math: ChallengeMath }) {
  const { math } = props
  if (!math.framing || !math.rung) return null
  const shift = math.rungDifficulty
  const tone = shift < 0 ? 'help' : shift > 0 || math.rung.degrees < 0 ? 'hinder' : 'even'
  return (
    <div class={`framing-result framing-${tone}`}>
      <span class="framing-margin" title="How far the framing roll landed from the difficulty">
        Framing {signed(math.framing.difference)}
      </span>
      <span class="framing-label">{math.rung.label}</span>
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
  // Challenges store the number; name the tier the GM's own difficulty came from when one matches.
  const tier = session.rules.challenges.difficulties.find((d) => d.value === ch.difficulty)?.label ?? null
  const isViewerTurn = role === 'player' && !!viewerCharId && ch.charId === viewerCharId
  // Only the player who rolled acts on it, and only once the dice are in, until the GM closes it.
  const acting = isViewerTurn && rolled && !ch.closed
  const exertion = session.availableExertion(ch)
  const spendControls = (roll: 'framing' | 'resolution') =>
    acting ? (
      <button
        type="button"
        class="exert-spend"
        hx-post={`/c/${viewerCharId}/challenge/spend-exertion`}
        hx-vals={JSON.stringify({ roll })}
        hx-swap="none"
        disabled={exertion <= 0 || undefined}
      >
        + exertion
      </button>
    ) : undefined
  const approach = session.approachState(ch)
  // Whenever exertion is in hand and no approach effect is waiting, a roll's dice are reroll
  // buttons — on both rolls, since both are on the table at once.
  const rerollAction = (roll: 'framing' | 'resolution') => {
    if (!acting || approach?.pending || exertion <= 0) return undefined
    return (index: number): DieAction => ({
      kind: 'reroll',
      url: `/c/${viewerCharId}/challenge/reroll?roll=${roll}&index=${index}`,
      title: 'Reroll with exertion',
    })
  }
  // A pending approach effect owns the resolution dice while it lasts — it is the step the board
  // is waiting on, so it takes those dice over from the reroll buttons. The framing roll is never
  // an approach target, so its dice stay rerollable throughout.
  const pendingKind = acting && approach?.pending ? approach.effect?.kind : undefined
  // Multi-die effects never take the same die twice, so dice already used drop out.
  const picked = (index: number) => ch.approachPicked.includes(`resolution:${index}`)
  const tap = (kind: DieAction['kind'], effect: string, title: string) => (index: number) =>
    picked(index)
      ? undefined
      : {
          kind,
          url: `/c/${viewerCharId}/challenge/approach-pick?effect=${effect}&index=${index}`,
          title: `${title} (${approach!.approach.label})`,
        }
  const resolutionDieAction = () => {
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
      return (index: number) => (session.tweakableDie(ch, index) ? tapper(index) : undefined)
    }
    // Perfect choice: discard one die, then copy another (the discarded one is already spent).
    if (pendingKind === 'discard_double') {
      return approach!.step === 'first'
        ? tap('discard', 'discard', 'Discard this die')
        : tap('face-change', 'copy', 'Copy this die')
    }
    return rerollAction('resolution')
  }
  return (
    <div class="challenge">
      {ch.description && <h3 class="challenge-description">{ch.description}</h3>}
      <div class="challenge-head">
        <span class={`stakes stakes-${ch.stakes}`}>{stakesLabel(ch.stakes)} stakes</span>
        {math.success !== null && (
          <span class={math.success ? 'result success' : 'result failure'}>
            {math.success ? 'Success' : 'Failure'}
          </span>
        )}
        {degreeText(math.degrees) && <span class="challenge-degree">{degreeText(math.degrees)}</span>}
        {ch.closed && <span class="badge closed">Done</span>}
      </div>
      <DifficultyPanel
        math={math}
        tier={tier}
        controls={role === 'gm' && !ch.closed ? <CircumstanceControls value={ch.circumstance} /> : undefined}
      />
      {/* One box when the GM skipped framing, two when they didn't. */}
      <div class={framingField ? 'challenge-numbers' : 'challenge-numbers solo'}>
        {framingField && (
          <RollBox
            kind="Framing"
            field={framingField}
            label={framingField.label}
            target={math.target}
            side={ch.framing}
            outcome={math.framing}
            faces={session.rules.challenges.faces}
            skillBonus={math.skillBonus}
            exertion={ch.exertionFraming}
            dieAction={rerollAction('framing')}
            attemptLabel={role !== 'player'}
            controls={spendControls('framing')}
          />
        )}
        <RollBox
          kind="Resolution"
          field={resolutionField}
          label={resolutionField?.label ?? ch.resolutionAbility}
          target={math.resolutionTarget}
          targetShift={math.rungDifficulty}
          side={ch.resolution}
          outcome={math.resolution}
          faces={session.rules.challenges.faces}
          skillBonus={math.skillBonus}
          exertion={ch.exertionResolution}
          dieAction={resolutionDieAction()}
          attemptLabel={role !== 'player'}
          controls={spendControls('resolution')}
        />
      </div>
      <FramingResult math={math} />
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
      {role === 'gm' && rolled && !ch.closed && (
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
        const math = session.challengeMath(ch)
        const framingField = ch.framingAbility ? session.rules.fields.get(ch.framingAbility) : undefined
        const resolutionField = session.rules.fields.get(ch.resolutionAbility)
        const char = ch.charId ? session.characters.get(ch.charId) : null
        return (
          <li class={math.success === null ? undefined : math.success ? 'success' : 'failure'}>
            <span class="challenge-log-what">{ch.description || '—'}</span>
            <span class="challenge-log-who">{char?.name ?? 'Nobody rolled'}</span>
            {/* The effective number, not the GM's raw one — hence the note when something moved it. */}
            <span class="challenge-log-numbers">
              {math.resolutionTarget} ·{framingField ? ` ${framingField.label} /` : ''}{' '}
              {resolutionField?.label} · {stakesLabel(ch.stakes)}
              {ch.circumstance !== 0 && ' · circumstance'}
              {math.skillBonus > 0 && ` · ${math.skillLabel?.toLowerCase()}`}
            </span>
            {math.success !== null && (
              <span class="challenge-log-result">
                {math.success ? 'Success' : 'Failure'}
                {degreeText(math.degrees) && ` · ${degreeText(math.degrees)}`}
              </span>
            )}
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
