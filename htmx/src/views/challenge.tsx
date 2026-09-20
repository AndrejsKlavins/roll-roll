// Public challenge board: big main/supporting difficulty numbers, the joined player's roll,
// and a history log of past challenges. Shared between /table (the shared screen), /gm (setup +
// oversight) and the player's own page (join/roll controls) — role picks what's interactive.
import type { NumberField } from '../rules'
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

/** One side's big number: target, then (once rolled) dice, skill bonus, final sum and difference. */
function DifficultyBox(props: {
  label: string
  target: number
  side: ChallengeSide | null
  skillPoints: number
  outcome: SideOutcome | null
  stakes: string
}) {
  const { label, target, side, skillPoints, outcome, stakes } = props
  const cls = ['difficulty-box', outcome && (outcome.success ? 'success' : 'failure')].filter(Boolean).join(' ')
  return (
    <div class={cls}>
      <div class="difficulty-label">{label}</div>
      <div class="difficulty-target">{target}</div>
      {side && outcome && (
        <div class="difficulty-result">
          <div class="dice-faces">
            {side.dice.map((d) => (
              <span class="die-face">{d}</span>
            ))}
            {skillPoints !== 0 && <span class="skill-bonus">{signed(skillPoints)}</span>}
          </div>
          <div class="difficulty-sum">
            = {outcome.sum} <span class="vs">vs {target}</span>
          </div>
          <div class="difficulty-diff">{signed(outcome.difference)}</div>
          {degreeText(outcome, stakes) && <div class="difficulty-degree">{degreeText(outcome, stakes)}</div>}
        </div>
      )}
    </div>
  )
}

/** Approach + skill pick, then Roll — shown to the joined player before rolling. */
function ChallengeSetupControls(props: { session: Session; ch: Challenge; charId: string }) {
  const { session, ch, charId } = props
  const { rules } = session
  const skills = [...rules.fields.values()].filter((f): f is NumberField => f.type === 'number' && f.trained)
  return (
    <form class="challenge-player-setup" hx-post={`/c/${charId}/challenge/setup`} hx-trigger="change" hx-swap="none">
      <fieldset class="approach-pick">
        <legend>Approach</legend>
        {rules.challenges.approaches.map((a) => (
          <label>
            <input type="radio" name="approach" value={a.id} checked={ch.approach === a.id || undefined} required /> {a.label}
          </label>
        ))}
      </fieldset>
      <label class="skill-pick">
        Skill boost
        <select name="skill">
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
    </form>
  )
}

/** Live main/support point split for the declared skill — shown after rolling. */
function ChallengeSkillPointsControls(props: { session: Session; ch: Challenge; charId: string }) {
  const { session, ch, charId } = props
  const char = session.characters.get(charId)!
  const skillField = session.rules.fields.get(ch.skill!) as NumberField
  const rank = Math.round(Number(session.baseOf(char, skillField)))
  return (
    <form class="challenge-skill-points" hx-post={`/c/${charId}/challenge/skill-points`} hx-trigger="change" hx-swap="none">
      <span class="muted small">
        {skillField.label} (rank {rank}) —
      </span>
      <label>
        to {session.rules.fields.get(ch.mainAbility)?.label}
        <input type="number" name="main" min="0" max={rank} value={ch.mainSkillPoints} />
      </label>
      <label>
        to {session.rules.fields.get(ch.supportAbility)?.label}
        <input type="number" name="support" min="0" max={rank} value={ch.supportSkillPoints} />
      </label>
    </form>
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
  const mainField = session.rules.fields.get(ch.mainAbility)
  const supportField = session.rules.fields.get(ch.supportAbility)
  const outcome = session.challengeOutcome(ch)
  const isViewerTurn = role === 'player' && !!viewerCharId && (ch.charId === null || ch.charId === viewerCharId)
  return (
    <div class="challenge">
      <div class="challenge-head">
        <span class={`stakes stakes-${ch.stakes}`}>{stakesLabel(ch.stakes)} stakes</span>
        {outcome && <span class={outcome.success ? 'result success' : 'result failure'}>{outcome.success ? 'Success' : 'Failure'}</span>}
      </div>
      <div class="challenge-numbers">
        <DifficultyBox
          label={mainField?.label ?? ch.mainAbility}
          target={ch.mainDifficulty}
          side={ch.main}
          skillPoints={ch.mainSkillPoints}
          outcome={outcome?.main ?? null}
          stakes={ch.stakes}
        />
        <DifficultyBox
          label={supportField?.label ?? ch.supportAbility}
          target={ch.supportDifficulty}
          side={ch.support}
          skillPoints={ch.supportSkillPoints}
          outcome={outcome?.support ?? null}
          stakes={ch.stakes}
        />
      </div>
      <ChallengeAbilities session={session} ch={ch} />
      {isViewerTurn && ch.charId === null && (
        <form class="challenge-join" hx-post={`/c/${viewerCharId}/challenge/join`} hx-swap="none">
          <button type="submit" class="primary">
            Join this challenge
          </button>
        </form>
      )}
      {isViewerTurn && ch.charId === viewerCharId && !ch.main && (
        <ChallengeSetupControls session={session} ch={ch} charId={viewerCharId!} />
      )}
      {isViewerTurn && ch.charId === viewerCharId && ch.main && ch.skill && (
        <ChallengeSkillPointsControls session={session} ch={ch} charId={viewerCharId!} />
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

/** GM-only: configure and start a new challenge (any current one falls into the log). */
export function ChallengeSetupForm(props: { session: Session }) {
  const { session } = props
  const { rules } = session
  const abilities = [...rules.fields.values()].filter((f): f is NumberField => isBaseField(f) && !f.trained)
  const step = rules.challenges.rankStep * 2
  return (
    <form class="card challenge-setup-form" hx-post="/gm/challenge/start" hx-swap="none">
      <h3>Start challenge</h3>
      <label>
        Main ability
        <select name="main_ability" required>
          {abilities.map((f) => (
            <option value={f.id}>{f.label}</option>
          ))}
        </select>
      </label>
      <label>
        Main difficulty
        <select
          onchange={`this.form.main_difficulty.value=this.value;this.form.support_difficulty.value=Number(this.value)-${step}`}
        >
          <option value="" disabled selected>
            Pick a tier…
          </option>
          {rules.challenges.difficulties.map((d) => (
            <option value={d.value}>
              {d.label} ({d.value})
            </option>
          ))}
        </select>
        <input type="number" name="main_difficulty" required />
      </label>
      <label>
        Support ability
        <select name="support_ability" required>
          {abilities.map((f) => (
            <option value={f.id}>{f.label}</option>
          ))}
        </select>
      </label>
      <label>
        Support difficulty
        <input type="number" name="support_difficulty" required />
      </label>
      <fieldset class="stakes-pick">
        <legend>Stakes</legend>
        <label>
          <input type="radio" name="stakes" value="low" /> Low
        </label>
        <label>
          <input type="radio" name="stakes" value="normal" checked /> Normal
        </label>
        <label>
          <input type="radio" name="stakes" value="high" /> High
        </label>
      </fieldset>
      <button type="submit">Start challenge</button>
    </form>
  )
}

export function ChallengeBoard(props: { session: Session; role: 'gm' | 'player' | 'table'; viewerCharId?: string; oob?: boolean }) {
  const { session, role, viewerCharId } = props
  const ch = session.currentChallenge()
  const history = session.challenges.slice(0, -1).reverse()
  return (
    <section id="challenge-board" class="challenge-board" hx-swap-oob={oobAttr(props.oob)}>
      {role === 'gm' && <ChallengeSetupForm session={session} />}
      {ch ? (
        <CurrentChallenge session={session} ch={ch} role={role} viewerCharId={viewerCharId} />
      ) : (
        <p class="muted">No challenge yet.</p>
      )}
      {role !== 'player' && <ChallengeLog session={session} entries={history} />}
    </section>
  )
}
