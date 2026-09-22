// Public challenge board: big main/supporting difficulty numbers, the joined player's roll,
// and a history log of past challenges. Shared between /table (the shared screen), /gm (setup +
// oversight) and the player's own page (join/roll controls) — role picks what's interactive.
import { raw } from 'hono/html'
import type { ApproachEffect, ApproachWhen, FaceName, Icon, NumberField } from '../rules'
import type { Child } from 'hono/jsx'
import { isBaseField, type Challenge, type ChallengeSide, type Session, type SideOutcome } from '../session'

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
  action?: DieAction
}) {
  const face = faceName(props.faces, props.faceId)
  const style = face?.color ? `--face-color: ${face.color}` : undefined
  const inner = (
    <>
      <span class="die-face">{props.value}</span>
      {face && <span class="die-name">{face.label}</span>}
      {!!props.rerolled && <span class="die-rerolls">Reroll {props.rerolled}</span>}
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
type DieAction = { kind: 'reroll' | 'discard'; url: string; title: string }

/** One side's big number: target, then (once rolled) dice, skill bonus, final sum and difference. */
function DifficultyBox(props: {
  field: NumberField | undefined
  label: string
  target: number
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
      </div>
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
  charId?: string
  abilities: { side: 'main' | 'support'; label: string; field: NumberField | undefined }[]
}) {
  const { session, ch, acting } = props
  const state = session.approachState(ch)
  if (!state) return null
  const { effect } = state
  // "Challenge done" ends the pick too: an effect nobody applied in time simply went unused.
  const pending = state.pending && !!effect && !ch.closed
  const note = pending
    ? pickPrompt(effect!, acting)
    : effect
      ? state.pending
        ? `${effect.label} — not used`
        : ch.approachActivated
          ? `${effect.label} — done`
          : effect.label
      : state.status === 'active'
        ? ch.approachActivated
          ? 'Activated'
          : state.approach.when === 'failure'
            ? 'In effect — the roll is failing'
            : 'In effect'
        : state.status === 'skipped'
          ? 'Skipped — the roll succeeded'
          : 'Not activated'
  const cls = ['approach-die', `approach-${state.status}`, pending && 'approach-pending'].filter(Boolean).join(' ')
  return (
    <div class={cls}>
      <div class="approach-label">{state.approach.label}</div>
      <span class="die">
        <span class="die-face">{state.die}</span>
      </span>
      <div class="approach-note">{note}</div>
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
      {/* Extra dice are the one effect with no die to tap: the player picks an ability here. */}
      {acting && pending && effect!.kind === 'extra_dice' && (
        <div class="approach-sides">
          {props.abilities.map((a) => (
            <button
              type="button"
              class="approach-side-btn"
              style={a.field?.color ? `--field-color: ${a.field.color}; --field-ink: ${a.field.ink}` : undefined}
              hx-post={`/c/${props.charId}/challenge/approach-pick?side=${a.side}`}
              hx-swap="none"
            >
              <IconChip icon={a.field?.icon} />
              <span class="label">{a.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

/** What the player (or everyone else, watching) is told to do while an effect waits for a pick. */
function pickPrompt(effect: ApproachEffect, acting: boolean) {
  const who = acting ? 'Tap' : 'Player taps'
  if (effect.kind === 'discard') return `${who} a die to discard it`
  if (effect.kind === 'reroll') return `${who} a die to reroll it`
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
  const dieAction = (side: 'main' | 'support') => {
    if (pendingKind === 'discard' || pendingKind === 'reroll') {
      const verb = pendingKind === 'discard' ? 'Discard this die' : 'Reroll this die'
      return (index: number): DieAction => ({
        kind: pendingKind,
        url: `/c/${viewerCharId}/challenge/approach-pick?effect=${pendingKind}&side=${side}&index=${index}`,
        title: `${verb} (${approach!.approach.label})`,
      })
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
          target={ch.mainDifficulty}
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
          target={ch.supportDifficulty}
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
      <ApproachDie session={session} ch={ch} acting={acting} charId={viewerCharId} abilities={abilities} />
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
              {mainField?.label} {ch.mainDifficulty} / {supportField?.label} {ch.supportDifficulty} · {stakesLabel(ch.stakes)}
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
