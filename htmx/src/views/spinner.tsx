// Spinner challenge check (user-designed): the dice challenge's alternative. The GM starts it
// (SpinnerDialog); the player picks a skill and spins the framing, may exert on it, accepts it,
// and then the resolution's 1..N spinners spin (animated by public/app.js, stopping dead).
import { spinnerAdvantage, spinnerColor, type NumberField, type SpinnerConfig } from '../rules'
import { isBaseField, type Session } from '../session'
import {
  MAX_SPINNER_CIRCUMSTANCE,
  MAX_SPINNER_RANK,
  SPINNER_RANK_STEP,
  spinnerMath,
  spinnerRanks,
  spinnerOpenStep,
  spinnerShift,
  type SpinnerCheck,
  type SpinnerExertKind,
  type SpinnerRoll,
  type SpinnerSide,
  type SpinnerStep,
} from '../spinner'
import { AbilityPicker, ChallengePlayerPicker, DifficultyPicker, IconChip } from './challenge'

const signed = (n: number) => (n > 0 ? `+${n}` : String(n))
const R = 100

/** A point on the rim at `deg` clockwise from straight up. */
const rim = (deg: number, r = R) => {
  const rad = (deg * Math.PI) / 180
  return `${(r * Math.sin(rad)).toFixed(2)} ${(-r * Math.cos(rad)).toFixed(2)}`
}

/**
 * One spinner: a wedge per segment, worst to best clockwise from the top, each labelled with the
 * value it counts for at this ability shift. The arrow points at `segment` (the middle of it), or
 * straight up before the spin. `data-segments` lets the client cycle the read-out while spinning.
 */
function Wheel(props: {
  config: SpinnerConfig
  shift: number
  segment: number | null
  dropped?: boolean
  /** Bought with exertion; named under it. */
  respin?: boolean
  /** New in this push: the client spins it. */
  fresh?: boolean
}) {
  const { config, shift, segment } = props
  const n = config.segments.length
  const step = 360 / n
  const angle = segment === null ? 0 : (segment + 0.5) * step
  // Coloured by the outcome value each segment counts for at this shift.
  const outcomes = config.segments.map((s) => spinnerColor(config, s.value + shift))
  const landed = segment === null ? null : outcomes[segment]!
  const outcome = (i: number) => config.segments[i]!.value + shift
  const cycle = config.segments.map((_, i) => ({ v: outcome(i), c: outcomes[i]!.color, i: outcomes[i]!.ink }))
  return (
    <div
      class={props.dropped ? 'spinner dropped' : 'spinner'}
      data-angle={segment === null ? undefined : String(angle)}
      data-fresh={props.fresh ? '' : undefined}
      data-segments={JSON.stringify(cycle)}
    >
      <svg viewBox="-110 -110 220 220" role="img" aria-label={segment !== null ? `Landed on ${outcome(segment)}` : 'Spinner'}>
        {outcomes.map((s, i) => (
          <path
            class={i === segment ? 'seg hit' : 'seg'}
            d={`M0 0 L${rim(i * step)} A${R} ${R} 0 ${step > 180 ? 1 : 0} 1 ${rim((i + 1) * step)} Z`}
            fill={s.color}
          />
        ))}
        {outcomes.map((s, i) => {
          const [x, y] = rim((i + 0.5) * step, R * 0.78).split(' ')
          return (
            <text x={x} y={y} fill={s.ink} class="seg-label" text-anchor="middle" dominant-baseline="central">
              {outcome(i)}
            </text>
          )
        })}
        <g class="spinner-arrow" transform={`rotate(${angle})`}>
          <polygon points="0,-60 7,-6 0,4 -7,-6" />
        </g>
        <circle r="11" class="spinner-hub" />
      </svg>
      <span
        class="spin-readout"
        style={landed ? `background: ${landed.color}; color: ${landed.ink}` : undefined}
      >
        {segment !== null ? outcome(segment) : '?'}
      </span>
      {props.respin && <span class="spin-tag">Exertion spin</span>}
    </div>
  )
}

/** "Advantage 2" / "Disadvantage 1" / "No advantage". */
const advantageLabel = (advantage: number) =>
  advantage === 0 ? 'No advantage' : `${advantage > 0 ? 'Advantage' : 'Disadvantage'} ${Math.abs(advantage)}`

/** Advantage in words. */
function advantageText(advantage: number) {
  if (advantage === 0) return 'No advantage — one resolution spinner'
  const n = Math.abs(advantage)
  return advantage > 0
    ? `Spin ${n} additional spinners, pick the best`
    : `Spin ${n} additional spinners, pick the worst`
}

/** One term of a roll's sum, drawn like a die: the value on a square tile, its name below. */
function Tile(props: { value: number | string; name: string; color?: string; ink?: string; tone?: string }) {
  const style = [props.color && `--face-color: ${props.color}`, props.ink && `--face-ink: ${props.ink}`].filter(Boolean)
  return (
    <span
      class={props.tone ? `die spin-tile ${props.tone}` : 'die spin-tile'}
      style={style.length ? style.join('; ') : undefined}
    >
      <span class="die-face">{props.value}</span>
      <span class="die-name">{props.name}</span>
    </span>
  )
}

/**
 * The roll's sum as tiles: the counting spin + the skill + circumstance + exertion (each only when
 * it is there), always ending on the difficulty (its own tile, set apart), then the total — the
 * outcome itself: 0 or more succeeds. Before its spin the spin tile is a "?" and there is no total
 * yet, so the player can see what will be added.
 */
function SpinEquation(props: {
  session: Session
  check: SpinnerCheck
  step: SpinnerStep
  side: SpinnerSide | null
  spinColor?: string
}) {
  const { session, check, step, side } = props
  const skillField = check.skill ? (session.rules.fields.get(check.skill) as NumberField | undefined) : undefined
  const spun = !!(check.framing || check.resolution)
  const skill = side?.skill ?? (spun ? check.skillBonus : session.spinnerSkillBonus(check))
  const circumstance = side?.circumstance ?? check.circumstance[step]
  const exertion = side?.exertion ?? 0
  // The difficulty's square takes the colour a spinner segment of that value would have.
  const diffLook = spinnerColor(session.rules.spinner!, check.difficulty)
  const terms = [
    <Tile value={side ? side.value : '?'} name="Spin" color={props.spinColor} />,
    skillField && <Tile value={skill} name={skillField.label} color={skillField.color} tone="skill" />,
    circumstance !== 0 && (
      <Tile value={signed(circumstance)} name="Circumstance" tone={circumstance > 0 ? 'help' : 'hinder'} />
    ),
    exertion > 0 && <Tile value={exertion} name="Exertion" tone="exertion" />,
    <Tile
      value={signed(check.difficulty)}
      name={check.tier ?? 'Difficulty'}
      color={diffLook.color}
      ink={diffLook.ink}
      tone="difficulty"
    />,
  ].filter(Boolean)
  return (
    <div class={side ? 'equation spin-equation spin-reveal' : 'equation spin-equation'}>
      <div class="equation-row">
        {terms.map((t, i) => (
          <>
            {i > 0 && <span class="equation-op">+</span>}
            {t}
          </>
        ))}
      </div>
      {side && <SpinOutcome total={side.total} step={step} config={session.rules.spinner!} />}
    </div>
  )
}

/**
 * The roll's outcome under its sum (user-designed), in three rows: the total in big type, green
 * from 0 up and red below; its rank groups stacked in a column — three pips each, every full group
 * one rank, the next one partly filled, the rest empty so the column reads as a meter; then the
 * outcome in words. On the resolution a rank is an upgrade or a complication, capped at 3; on the
 * framing it is the advantage it earns, which has no cap, so the column grows past 3 groups with it.
 */
function SpinOutcome(props: { total: number; step: SpinnerStep; config: SpinnerConfig }) {
  const { total, step, config } = props
  const cap =
    step === 'framing' ? Math.max(MAX_SPINNER_RANK, Math.ceil(Math.abs(total) / SPINNER_RANK_STEP)) : MAX_SPINNER_RANK
  const { rank, groups, over } = spinnerRanks(total, cap)
  const good = total >= 0
  const text =
    step === 'framing'
      ? advantageLabel(spinnerAdvantage(config, total))
      : `${good ? 'Success' : 'Failure'}${rank > 0 ? ` · Rank ${rank} ${good ? 'upgrade' : 'complication'}` : ''}`
  return (
    <div class={`spin-outcome ${good ? 'good' : 'bad'}`} title={`Every ${SPINNER_RANK_STEP} is a rank`}>
      <b class="spin-outcome-total">{signed(total)}</b>
      <div class="rank-column">
        {groups.map((filled, g) => (
          <span class={filled === SPINNER_RANK_STEP ? 'rank-group full' : 'rank-group'}>
            <span class="rank-num">{g + 1}</span>
            <span class="rank-dots">
              {Array.from({ length: SPINNER_RANK_STEP }, (_, i) => (
                <span class={i < filled ? 'rank-pip on' : 'rank-pip'} />
              ))}
            </span>
            <span class="rank-over">{over && g === groups.length - 1 ? '+' : ''}</span>
          </span>
        ))}
      </div>
      <span class="spin-outcome-text">{text}</span>
    </div>
  )
}

/** The circumstance − / + for one roll (a plus helps the player). */
function CircumstanceStepper(props: { url: string; step: SpinnerStep; value: number }) {
  const { url, step, value } = props
  const button = (delta: number, label: string, disabled: boolean) => (
    <button
      type="button"
      class="circumstance-step"
      hx-post={`${url}/circumstance?roll=${step}&delta=${delta}`}
      hx-swap="none"
      disabled={disabled || undefined}
      title={delta > 0 ? 'Circumstance in the player’s favour' : 'Circumstance against the player'}
    >
      {label}
    </button>
  )
  return (
    <div class="circumstance-set">
      <span class="circumstance-legend">Circumstance</span>
      <div class="circumstance-controls">
        {button(-1, '−', value <= -MAX_SPINNER_CIRCUMSTANCE)}
        <output>{signed(value)}</output>
        {button(1, '+', value >= MAX_SPINNER_CIRCUMSTANCE)}
      </div>
    </div>
  )
}

/**
 * Exertion on the open roll, paid from the pool that matches its ability (Stamina for Strength,
 * Agility and Endurance; Willpower for the rest): +1, or one more spin that counts instead.
 */
function SpinExertion(props: { session: Session; check: SpinnerCheck; step: SpinnerStep; url: string }) {
  const { session, check, step, url } = props
  const pool = session.spinnerExertionPool(check, step)
  const stat = pool ? session.rules.derived.find((d) => d.id === pool.statId) : undefined
  if (!pool || !stat) return null
  const button = (kind: SpinnerExertKind, label: string, title: string) => (
    <button
      type="button"
      class="exert-btn"
      style={stat.color ? `--field-color: ${stat.color}; --field-ink: ${stat.ink}` : undefined}
      hx-post={`${url}/exert?roll=${step}&kind=${kind}`}
      hx-swap="none"
      disabled={pool.left <= 0 || undefined}
      title={title}
    >
      <IconChip icon={stat.icon} />
      <span class="label">{label}</span>
    </button>
  )
  return (
    <div class="spin-exertion spin-reveal">
      <p class="muted">
        Exert {stat.label.toLowerCase()} — <b>{pool.left}</b> left
      </p>
      <div class="exert-buttons">
        {button('bonus', '+1', `Spend 1 ${stat.label.toLowerCase()} for +1 on this roll`)}
        {button('respin', 'Spin again', `Spend 1 ${stat.label.toLowerCase()} to spin once more — the new spin counts`)}
      </div>
    </div>
  )
}

/** Which new spins this push animates: the step's spins from index `from` on. */
export type SpinnerAnimation = { step: SpinnerStep; from: number }

function SpinBox(props: {
  session: Session
  check: SpinnerCheck
  title: string
  abilityId: string
  roll: SpinnerRoll | null
  side: SpinnerSide | null
  caption?: string
  step: SpinnerStep
  /** Where the viewer's controls post; null when they have none. */
  url: string | null
  animate?: SpinnerAnimation
}) {
  const { session, check, roll, side, step, url } = props
  const config = session.rules.spinner!
  const field = session.rules.fields.get(props.abilityId) as NumberField | undefined
  const char = session.characters.get(check.charId)
  // Before the spin, preview at the character's current rank.
  const rank = roll?.rank ?? (char && field ? Math.round(Number(session.valueOf(char, field))) : 3)
  const shift = spinnerShift(config, rank)
  const open = spinnerOpenStep(check) === step
  // The framing's circumstance decides the advantage, so it is fixed once the framing is accepted.
  const canNudge = !!url && !check.closed && (step === 'resolution' || !check.resolution)
  const fresh = props.animate?.step === step ? props.animate.from : null
  return (
    <div
      class={fresh !== null ? 'spin-box spinning' : 'spin-box'}
      data-step={step}
      style={field?.color ? `--field-color: ${field.color}; --field-ink: ${field.ink}` : undefined}
    >
      <div class="roll-box-head">
        <span class="spin-kind">{props.title}</span>
        <IconChip icon={field?.icon} />
        <span class="spin-ability">{field?.label ?? props.abilityId}</span>
        <span class="muted">
          rank {rank} ({signed(shift)})
        </span>
      </div>
      <div class="spin-wheels">
        {roll ? (
          roll.spins.map((s, i) => (
            <Wheel
              config={config}
              shift={shift}
              segment={s.segment}
              dropped={roll.spins.length > 1 && i !== roll.kept}
              respin={s.respin}
              fresh={fresh !== null && i >= fresh}
            />
          ))
        ) : (
          <Wheel config={config} shift={shift} segment={null} />
        )}
      </div>
      <SpinEquation
        session={session}
        check={check}
        step={step}
        side={side}
        spinColor={side ? spinnerColor(config, side.value).color : undefined}
      />
      {props.caption && <p class="spin-caption spin-reveal">{props.caption}</p>}
      {canNudge && (
        <div class="spin-box-controls spin-reveal">
          <CircumstanceStepper url={url!} step={step} value={check.circumstance[step]} />
        </div>
      )}
      {url && open && <SpinExertion session={session} check={check} step={step} url={url} />}
    </div>
  )
}

function SpinnerCard(props: {
  session: Session
  check: SpinnerCheck
  role: 'gm' | 'player' | 'table'
  viewerCharId?: string
  animate?: SpinnerAnimation
}) {
  const { session, check, role } = props
  const config = session.rules.spinner!
  const math = spinnerMath(check)
  const name = session.characters.get(check.charId)?.name ?? 'Someone'
  // The rolling player, or the GM on their behalf, may act on it until it is closed.
  const mayAct = !check.closed && (role === 'gm' || (role === 'player' && props.viewerCharId === check.charId))
  const url = role === 'gm' ? '/gm/spinner' : `/c/${check.charId}/spinner`
  const skills = [...session.rules.fields.values()].filter((f): f is NumberField => {
    const char = session.characters.get(check.charId)
    return f.type === 'number' && f.trained && !!char && session.fieldVisible(char, f.id)
  })
  const skillLabel = check.skill ? session.rules.fields.get(check.skill)?.label : null
  // What accepting the framing as it stands would give, while it is still open.
  const advantage = math.advantage ?? (math.framing ? spinnerAdvantage(config, math.framing.total) : null)
  const caption =
    advantage === null ? undefined : math.advantage === null ? `Accepting now: ${advantageText(advantage)}` : advantageText(advantage)
  return (
    <div class={`spinner-check ${math.success === null ? '' : math.success ? 'success' : 'failure'}`}>
      <div class="solo-head">
        <span class="solo-title">Spinner check</span>
        <b>{name}</b>
        {check.closed && <span class="badge closed">Done</span>}
        {math.resolution && (
          <span class={`result spin-reveal ${math.success ? 'success' : 'failure'}`}>
            {math.success ? 'Success' : 'Failure'} {signed(math.resolution.total)}
          </span>
        )}
      </div>
      {check.description && <p class="solo-description">{check.description}</p>}
      <p class="spin-difficulty">
        Difficulty <b>{signed(check.difficulty)}</b>
        {check.tier && ` (${check.tier})`}
        {skillLabel && <span class="muted"> · {skillLabel}{check.framingAbility ? ' on both' : ''}</span>}
      </p>
      {check.framingAbility && (
        <SpinBox
          session={session}
          check={check}
          title="Framing"
          step="framing"
          abilityId={check.framingAbility}
          roll={check.framing}
          side={math.framing}
          url={mayAct ? url : null}
          caption={caption}
          animate={props.animate}
        />
      )}
      {mayAct && !check.framing && !check.resolution && (
        <div class="spin-controls">
          <label class="skill-pick">
            Skill
            <select name="skill" hx-post={`${url}/skill`} hx-trigger="change" hx-swap="none">
              <option value="">None</option>
              {skills.map((f) => (
                <option value={f.id} selected={check.skill === f.id || undefined}>
                  {f.label}
                </option>
              ))}
            </select>
          </label>
          <button type="button" class="primary" hx-post={`${url}/spin`} hx-swap="none">
            {(check.framingAbility ? 'Spin framing' : 'Spin resolution') + (role === 'gm' ? ` for ${name}` : '')}
          </button>
        </div>
      )}
      {mayAct && spinnerOpenStep(check) === 'framing' && (
        <div class="spin-controls spin-reveal">
          <button type="button" class="primary" hx-post={`${url}/accept`} hx-swap="none">
            Accept framing — spin resolution
          </button>
        </div>
      )}
      <SpinBox
        session={session}
        check={check}
        title="Resolution"
        step="resolution"
        abilityId={check.resolutionAbility}
        roll={check.resolution}
        side={math.resolution}
        url={mayAct ? url : null}
        animate={props.animate}
      />
      {role === 'gm' && !check.closed && (
        <button type="button" class="small" hx-post="/gm/spinner/done" hx-swap="none">
          Spinner check done
        </button>
      )}
    </div>
  )
}

/**
 * The spinner check's own swap target, on all three screens. A player sees it only while it is
 * theirs and open. `animate` (only on the push right after a spin) says which spins are new; the
 * client spins those, and everything marked `spin-reveal` in their box stays hidden until they stop.
 */
export function SpinnerBoard(props: {
  session: Session
  role: 'gm' | 'player' | 'table'
  viewerCharId?: string
  oob?: boolean
  animate?: SpinnerAnimation
}) {
  const { session, role, viewerCharId } = props
  const check = session.rules.spinner ? session.spinners.current() : null
  const visible = check && (role !== 'player' || (!check.closed && check.charId === viewerCharId))
  const animate = visible && props.animate && check[props.animate.step] ? props.animate : undefined
  return (
    <section
      id="spinner-board"
      class={animate ? 'spinner-board spinning' : 'spinner-board'}
      data-spin-anim={animate ? `${animate.step}-${animate.from}` : undefined}
      hx-swap-oob={props.oob ? 'true' : undefined}
    >
      {visible && <SpinnerCard session={session} check={check} role={role} viewerCharId={viewerCharId} animate={animate} />}
    </section>
  )
}

const AFTER_SPINNER_START = [
  'if (!event.detail.successful) return;',
  'const d = Alpine.$data(this);',
  "Object.assign(d, { description: '', diff: '', diffValue: '', framingAbility: '', resolutionAbility: '', charId: '' });",
  "this.closest('dialog').close()",
].join(' ')

/** GM-only: set up a spinner check — difficulty, framing and resolution ability, who spins. */
export function SpinnerDialog(props: { session: Session }) {
  const { session } = props
  const { rules } = session
  if (!rules.spinner) return null
  const abilities = [...rules.fields.values()].filter((f): f is NumberField => isBaseField(f) && !f.trained)
  const difficulties = rules.spinner.difficulties
  const state = {
    description: '',
    diff: '',
    diffValue: '',
    framingAbility: '',
    resolutionAbility: '',
    charId: '',
    abilities: abilities.map((f) => ({ id: f.id, label: f.label, color: f.color ?? '' })),
    difficulties: difficulties.map((d) => ({ id: d.id, label: d.label, value: d.value })),
  }
  return (
    <dialog id="spinner-dialog" class="challenge-dialog">
      <form hx-post="/gm/spinner/start" hx-swap="none" x-data={JSON.stringify(state)} hx-on--after-request={AFTER_SPINNER_START}>
        <header class="dialog-head">
          <h3>Spinner challenge check</h3>
          <button type="button" class="small" x-on:click="$el.closest('dialog').close()">
            Close
          </button>
        </header>
        <label class="challenge-description-field">
          <span>What is the challenge? (optional)</span>
          <input name="description" x-model="description" placeholder="e.g. Climb the cliff" maxlength={200} autocomplete="off" />
        </label>
        <DifficultyPicker
          difficulties={difficulties}
          hint="Added to both rolls — a total of 0 or more succeeds."
          signed
        />
        <AbilityPicker
          title="Framing ability (optional)"
          hint="Spun first; its margin gives advantage (or disadvantage) on the resolution spin. Skip it and the resolution is one spin."
          abilityVar="framingAbility"
          abilities={abilities}
          skippable
        />
        <AbilityPicker
          title="Resolution ability"
          hint="This is the one that decides it. Spun once the framing is accepted."
          abilityVar="resolutionAbility"
          abilities={abilities}
        />
        <section class="side-pick player-pick">
          <h4>Who spins</h4>
          <ChallengePlayerPicker session={session} id="spinner-players" />
        </section>
        <input type="hidden" name="difficulty" x-model="diffValue" />
        <input type="hidden" name="framing_ability" x-model="framingAbility" />
        <input type="hidden" name="resolution_ability" x-model="resolutionAbility" />
        <input type="hidden" name="char_id" x-model="charId" />
        <button type="submit" class="primary" x-bind:disabled="!(diff && resolutionAbility && charId)">
          Start spinner check
        </button>
      </form>
    </dialog>
  )
}
