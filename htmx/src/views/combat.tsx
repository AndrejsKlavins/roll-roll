// Combat on the shared screens: the table's encounter board (every enemy, by name and condition
// only — the numbers stay on the GM's Bestiary) and the history-log lines for attacks, both ways.
import { defence, poolLabel, tierEffect, woundLabel } from '../combat'
import type { Enemy } from '../enemies'
import { enemyAttackMath, type Challenge, type EnemyAttack, type Session } from '../session'

const signed = (n: number) => (n >= 0 ? `+${n}` : String(n))

/** How an enemy looks from across the table: a word, never its numbers. */
export function enemyCondition(e: Enemy): { label: string; tone: 'fresh' | 'hurt' | 'bad' | 'down' } {
  if (e.health < 0) return { label: 'Down', tone: 'down' }
  if (e.health >= e.stats.health) return { label: 'Unhurt', tone: 'fresh' }
  if (e.health * 2 > e.stats.health) return { label: 'Wounded', tone: 'hurt' }
  return { label: 'Badly wounded', tone: 'bad' }
}

/**
 * The table's view of the fight (user decision: everyone sees every enemy; only the GM sees their
 * stats): the round, and each enemy's name, condition and whether it has already been attacked
 * this round (its Evasion is spent). Hidden while the encounter is empty.
 */
export function EncounterBoard(props: { session: Session; oob?: boolean }) {
  const { bestiary } = props.session
  const enemies = bestiary.bySpeed()
  return (
    <section id="encounter-board" class="encounter-board" hx-swap-oob={props.oob ? 'true' : undefined}>
      {enemies.length > 0 && (
        <div class="card encounter-public">
          <header class="encounter-public-head">
            <h3>Encounter</h3>
            <span class="encounter-round">Round {bestiary.round}</span>
          </header>
          <ul class="encounter-enemies">
            {enemies.map((e) => {
              const c = enemyCondition(e)
              return (
                <li class={`encounter-enemy ${c.tone}`}>
                  <span class="encounter-enemy-name">{e.name}</span>
                  <span class="encounter-enemy-state">
                    {c.label}
                    {e.mind < 0 && c.tone !== 'down' ? ' · broken' : ''}
                  </span>
                  {bestiary.evasionSpent('enemy', e.id) && c.tone !== 'down' && (
                    <span class="encounter-spent" title="Already attacked this round: its Evasion is spent">
                      attacked
                    </span>
                  )}
                </li>
              )
            })}
          </ul>
        </div>
      )}
    </section>
  )
}

/**
 * A player's attack in the history log: "Mara attacks Wolf 2 — Good hit, normal wound (−2
 * Health)". Green when it wounded, red when it didn't; plain while it is still being rolled.
 */
export function AttackLogLine(props: { session: Session; ch: Challenge }) {
  const { session, ch } = props
  const a = ch.attack!
  const math = session.challengeMath(ch).attack!
  const name = (ch.charId ? session.characters.get(ch.charId)?.name : null) ?? 'Someone'
  // Settled once the damage is in, or at a miss; until then it's still going.
  const settled = !!math.tier && (math.tier.miss || !!ch.resolution)
  const cls = settled ? (math.wounds > 0 ? 'success' : 'failure') : undefined
  return (
    <li class={cls}>
      <b>{name}</b> attacks <b>{a.enemyName}</b>
      {ch.description && ` (${ch.description})`}
      {math.tier
        ? math.tier.miss
          ? ' — Miss'
          : !ch.resolution
            ? ` — ${math.tier.label}, damage not rolled yet`
          : ` — ${math.tier.label}, ${woundLabel(math.wounds).toLowerCase()}${math.wounds > 0 ? ` (−${math.wounds} ${poolLabel(a.pool)})` : ''}`
        : ' — not rolled'}
    </li>
  )
}

/**
 * An enemy's attack in the history log, with the numbers the player can check against their own
 * sheet: "Wolf 1 attacks Mara — hit 12 vs Evasion 7: Good hit · damage 8 vs Physical resistance
 * 5: Normal wound, Health 4 → 2". Red when it hurt them, green when it didn't.
 */
export function EnemyAttackLogLine(props: { attack: EnemyAttack }) {
  const a = props.attack
  const m = enemyAttackMath(a)
  const hitVs = a.hitVs === 'evasion' && a.evasionSpent ? 'spent Evasion' : defence(a.hitVs).label
  return (
    <li class={a.wounds > 0 ? 'failure enemy-attack-line' : 'success enemy-attack-line'}>
      <b>{a.enemyName}</b> attacks <b>{a.charName}</b> — hit {m.hitTotal} vs {hitVs} {a.hitTarget}: {m.tier.label}
      {m.damageTotal !== null && (
        <>
          {' '}
          · damage {m.damageTotal} vs {defence(a.damageVs).label} {a.damageTarget}: {woundLabel(a.wounds)}
          {a.wounds > 0 && `, ${poolLabel(a.pool)} ${a.from} → ${a.to}`}
        </>
      )}
    </li>
  )
}

/**
 * The GM's full breakdown of an enemy attack (Bestiary screen): the dice, the bonus, the tier
 * and what it did, the damage dice (a glancing blow's dropped die struck through) and the result.
 */
export function EnemyAttackDetail(props: { attack: EnemyAttack }) {
  const a = props.attack
  const m = enemyAttackMath(a)
  const dice = (d: number[], discarded?: boolean[]) =>
    d.map((v, i) => (discarded?.[i] ? <s>{v}</s> : <span>{v}</span>)).flatMap((el, i) => (i ? [', ', el] : [el]))
  return (
    <div class={`enemy-attack-detail ${a.wounds > 0 ? 'hurt' : 'miss'}`}>
      <div>
        <b>{a.enemyName}</b> → <b>{a.charName}</b>
      </div>
      <div>
        Hit [{dice(a.hit.dice)}] {signed(a.hitBonus)} = <b>{m.hitTotal}</b> vs{' '}
        {a.hitVs === 'evasion' && a.evasionSpent ? 'spent Evasion' : defence(a.hitVs).short} {a.hitTarget} ({signed(m.hitMargin)}):{' '}
        {m.tier.label} — {tierEffect(m.tier)}
      </div>
      {a.damage && (
        <div>
          Damage [{dice(a.damage.dice, a.damage.discarded)}]{a.critDie && ` + crit ${a.critDie.value}`} {signed(a.damageBonus)}
          {m.tier.damageBonus ? ` ${signed(m.tier.damageBonus)} hit` : ''} = <b>{m.damageTotal}</b> vs {defence(a.damageVs).short}{' '}
          {a.damageTarget} ({signed(m.damageMargin!)}): {woundLabel(a.wounds)}
          {a.wounds > 0 && ` — ${poolLabel(a.pool)} ${a.from} → ${a.to}`}
        </div>
      )}
    </div>
  )
}
