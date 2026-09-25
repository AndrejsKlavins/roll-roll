// The GM's Bestiary screen (/gm/bestiary): the current encounter on top — one card per enemy,
// every number editable in place — and the enemy templates below, as a table with Spawn, Edit and
// Delete. Every action answers with the whole screen (#bestiary), and other open Bestiary tabs
// get the same by push.
import type { Enemy, EnemyStatKey, EnemyStats, EnemyTemplate } from '../enemies'
import { bonusLabel, diceLabel, ENEMY_STATS, MAX_DESCRIPTION, MAX_NAME, MAX_SPAWN } from '../enemies'
import { DEFENCES, WOUND_POOLS } from '../combat'
import type { NumberField } from '../rules'
import { isBaseField, type Session } from '../session'
import { AttackLogLine, EnemyAttackDetail } from './combat'
import { Layout } from './layout'

const rollLabel = (dice: number, rank: number, bonus: number) => `${diceLabel(dice, rank)}${bonus ? bonusLabel(bonus) : ''}`

/** A new template's starting numbers: the average human from the rules file's notes. */
const AVERAGE: EnemyStats = {
  health: 4,
  mind: 4,
  hitDice: 2,
  hitRank: 3,
  hitBonus: 2,
  damageDice: 2,
  damageRank: 3,
  damageBonus: 2,
  evasion: 7,
  physicalResistance: 5,
  mentalResistance: 5,
  speed: 3,
}

const statDef = (key: EnemyStatKey) => ENEMY_STATS.find((s) => s.key === key)!

export function BestiaryPage(props: { session: Session; clientId: string }) {
  const { session, clientId } = props
  return (
    <Layout
      title="Bestiary"
      system={session.rules.name}
      who={
        <>
          <a href="/gm">GM screen</a> · Bestiary
        </>
      }
      wsUrl={`/ws?bestiary=${clientId}`}
      gm
      headers={{ 'X-Client': clientId }}
    >
      <BestiaryMain session={session} />
    </Layout>
  )
}

/** The whole screen; every action swaps it (`hx-target="this"` is inherited by everything in it). */
export function BestiaryMain(props: { session: Session; oob?: boolean }) {
  const { session } = props
  return (
    <main
      id="bestiary"
      class="bestiary"
      hx-target="this"
      hx-swap="outerHTML"
      hx-sync="#bestiary:queue all"
      hx-swap-oob={props.oob ? 'true' : undefined}
    >
      <Encounter session={session} />
      <Templates session={session} />
    </main>
  )
}

// ---- encounter ----------------------------------------------------------------

function Encounter(props: { session: Session }) {
  const { bestiary } = props.session
  const enemies = bestiary.bySpeed()
  const down = enemies.filter((e) => e.health < 0).length
  return (
    <section class="encounter">
      <header class="bestiary-head">
        <h2>Encounter</h2>
        {enemies.length > 0 && (
          <span class="round-chip">
            Round {bestiary.round}
            <button
              type="button"
              class="small"
              hx-post="/gm/bestiary/round"
              title="Start the next round: everyone's Evasion is fresh again"
            >
              Next round
            </button>
          </span>
        )}
        <span class="muted">
          {enemies.length === 0
            ? 'No enemies yet — spawn some from the templates below.'
            : `${enemies.length} ${enemies.length === 1 ? 'enemy' : 'enemies'}${down ? `, ${down} down` : ''} · fastest first`}
        </span>
        <span class="spacer"></span>
        {down > 0 && (
          <button type="button" class="small" hx-post="/gm/bestiary/remove" hx-vals='{"which":"defeated"}'>
            Remove defeated
          </button>
        )}
        {enemies.length > 0 && (
          <button
            type="button"
            class="small danger"
            hx-post="/gm/bestiary/remove"
            hx-vals='{"which":"all"}'
            hx-confirm="Remove every enemy from the encounter?"
          >
            Clear encounter
          </button>
        )}
      </header>
      <RecentAttacks session={props.session} />
      <div class="enemy-grid">
        {enemies.map((e) => (
          <EnemyCard session={props.session} enemy={e} template={bestiary.template(e.templateId)} />
        ))}
      </div>
    </section>
  )
}

/** One number (or text) box on an enemy card; saved on change. The id keeps focus across swaps. */
function EnemyInput(props: { enemy: Enemy; field: string; value: number; label: string; min?: number; max?: number }) {
  const { enemy, field } = props
  return (
    <input
      id={`en-${enemy.id}-${field}`}
      name={field}
      type="number"
      step="1"
      min={props.min}
      max={props.max}
      value={props.value}
      aria-label={`${enemy.name}: ${props.label}`}
      hx-post={`/gm/enemy/${enemy.id}/set`}
      hx-trigger="change"
    />
  )
}

function StatInput(props: { enemy: Enemy; stat: EnemyStatKey }) {
  const def = statDef(props.stat)
  return (
    <EnemyInput
      enemy={props.enemy}
      field={props.stat}
      value={props.enemy.stats[props.stat]}
      label={def.label}
      min={def.min}
      max={def.max}
    />
  )
}

/** Health or Mind: − current / max +. Below 0 is down (Health) or broken (Mind). */
function Pool(props: { enemy: Enemy; pool: 'health' | 'mind' }) {
  const { enemy, pool } = props
  const label = pool === 'health' ? 'Health' : 'Mind'
  const current = enemy[pool]
  const max = enemy.stats[pool]
  return (
    <div class={`enemy-pool ${pool}${current < 0 ? ' out' : current < max ? ' hurt' : ''}`}>
      <span class="pool-label">{label}</span>
      <button
        type="button"
        class="small"
        hx-post={`/gm/enemy/${enemy.id}/pool`}
        hx-vals={JSON.stringify({ pool, delta: -1 })}
        aria-label={`${enemy.name}: ${label} −1`}
      >
        −
      </button>
      <EnemyInput enemy={enemy} field={pool} value={current} label={`current ${label}`} max={max} />
      <span class="of">/</span>
      <EnemyInput
        enemy={enemy}
        field={pool === 'health' ? 'maxHealth' : 'maxMind'}
        value={max}
        label={`max ${label}`}
        min={statDef(pool).min}
        max={statDef(pool).max}
      />
      <button
        type="button"
        class="small"
        hx-post={`/gm/enemy/${enemy.id}/pool`}
        hx-vals={JSON.stringify({ pool, delta: 1 })}
        aria-label={`${enemy.name}: ${label} +1`}
        disabled={current >= max}
      >
        +
      </button>
    </div>
  )
}

/** A roll's three numbers: [dice] d6 ( [rank] ) [bonus]. */
function RollInputs(props: { enemy: Enemy; label: string; dice: EnemyStatKey; rank: EnemyStatKey; bonus: EnemyStatKey }) {
  const { enemy } = props
  return (
    <div class="enemy-roll">
      <span class="stat-label">{props.label}</span>
      <span class="roll-inputs">
        <StatInput enemy={enemy} stat={props.dice} />
        <span>d6 (</span>
        <StatInput enemy={enemy} stat={props.rank} />
        <span>) +</span>
        <StatInput enemy={enemy} stat={props.bonus} />
      </span>
    </div>
  )
}

/**
 * The last few attacks, both ways, newest first — enemy attacks with their full dice (the GM's
 * view), players' attacks as their log line (their dice are on the challenge board).
 */
function RecentAttacks(props: { session: Session }) {
  const { session } = props
  const entries = [
    ...session.enemyAttacks.map((a) => ({ seq: a.seq, node: <EnemyAttackDetail attack={a} /> })),
    ...session.challenges
      .filter((ch) => ch.attack)
      .map((ch) => ({
        seq: ch.seq,
        node: (
          <ul class="challenge-log compact">
            <AttackLogLine session={session} ch={ch} />
          </ul>
        ),
      })),
  ]
    .sort((a, b) => b.seq - a.seq)
    .slice(0, 5)
  if (entries.length === 0) return null
  return (
    <details class="card recent-attacks" open>
      <summary>Recent attacks</summary>
      {entries.map((e) => e.node)}
    </details>
  )
}

/** The finished characters, for "attacks …" / "attacked by …" pickers. */
const fighters = (session: Session) => [...session.characters.values()].filter((c) => c.status === 'active')

/** Abilities a player's hit or damage roll can use (the sheet's untrained base fields). */
const abilities = (session: Session) =>
  [...session.rules.fields.values()].filter((f): f is NumberField => isBaseField(f) && !f.trained)

function Select(props: { name: string; label: string; options: { id: string; label: string }[]; value?: string }) {
  return (
    <label>
      <span class="stat-label">{props.label}</span>
      <select name={props.name}>
        {props.options.map((o) => (
          <option value={o.id} selected={o.id === props.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  )
}

/**
 * The GM decides what attacks what, from the enemy's card:
 * - **attacks a player**: rolled and settled on the spot (no active defence yet) — the wounds come
 *   off the player's sheet and the result goes to the table's log;
 * - **is attacked by a player**: starts that player's attack as the current challenge — hit and
 *   damage abilities, and which of the enemy's defences each roll goes against (Evasion and
 *   Physical resistance unless the GM says otherwise).
 */
function EnemyAttackForms(props: { session: Session; enemy: Enemy }) {
  const { session, enemy } = props
  const players = fighters(session).map((c) => ({ id: c.id, label: c.name }))
  if (players.length === 0) return <p class="muted enemy-no-players">No finished characters to fight yet.</p>
  const abilityOptions = abilities(session).map((f) => ({ id: f.id, label: f.label }))
  const pick = (id: string) => (abilityOptions.some((a) => a.id === id) ? id : abilityOptions[0]?.id)
  const defences = DEFENCES.map((d) => ({ id: d.id, label: d.label }))
  const spent = session.bestiary.evasionSpent('enemy', enemy.id)
  return (
    <div class="enemy-attack-forms">
      <details class="enemy-attack-form">
        <summary>{enemy.name} attacks…</summary>
        <form hx-post={`/gm/enemy/${enemy.id}/attack`}>
          <Select name="charId" label="Target" options={players} />
          <div class="attack-vs">
            <Select name="hitVs" label="Hit vs" options={defences} value="evasion" />
            <Select name="damageVs" label="Damage vs" options={defences} value="physical" />
            <Select name="pool" label="Wounds to" options={WOUND_POOLS} value="health" />
          </div>
          <button type="submit" class="small primary">
            Roll the attack
          </button>
        </form>
      </details>
      <details class="enemy-attack-form">
        <summary>A player attacks {enemy.name}…</summary>
        <form hx-post={`/gm/enemy/${enemy.id}/attacked`}>
          <Select name="charId" label="Attacker" options={players} />
          <div class="attack-vs">
            <Select name="hitAbility" label="Hit with" options={abilityOptions} value={pick('agility')} />
            <Select name="damageAbility" label="Damage with" options={abilityOptions} value={pick('strength')} />
          </div>
          <div class="attack-vs">
            <Select name="hitVs" label="Hit vs" options={defences} value="evasion" />
            <Select name="damageVs" label="Damage vs" options={defences} value="physical" />
            <Select name="pool" label="Wounds to" options={WOUND_POOLS} value="health" />
          </div>
          <label class="check">
            <input type="checkbox" name="spent" value="1" checked={spent} /> Its Evasion is spent (hit vs 0)
          </label>
          <input name="description" placeholder="How (optional), e.g. with a spear" maxlength={200} autocomplete="off" />
          <button type="submit" class="small primary">
            Start the attack
          </button>
        </form>
      </details>
    </div>
  )
}

function EnemyCard(props: { session: Session; enemy: Enemy; template?: EnemyTemplate }) {
  const { enemy, template } = props
  const down = enemy.health < 0
  const changed = template && ENEMY_STATS.some((s) => template.stats[s.key] !== enemy.stats[s.key])
  return (
    <article class={`card enemy-card${down ? ' down' : ''}`} id={`enemy-${enemy.id}`}>
      <header class="enemy-head">
        <input
          id={`en-${enemy.id}-name`}
          name="name"
          class="enemy-name"
          value={enemy.name}
          maxlength={MAX_NAME}
          aria-label="Name"
          hx-post={`/gm/enemy/${enemy.id}/set`}
          hx-trigger="change"
        />
        {down && <span class="badge down-badge">Down</span>}
        {!down && props.session.bestiary.evasionSpent('enemy', enemy.id) && (
          <span class="badge spent-badge" title="Attacked this round: later attacks roll against Evasion 0">
            Evasion spent
          </span>
        )}
        {enemy.mind < 0 && <span class="badge broken-badge">Broken</span>}
        <button
          type="button"
          class="icon remove"
          hx-post="/gm/bestiary/remove"
          hx-vals={JSON.stringify({ which: enemy.id })}
          title={`Remove ${enemy.name}`}
          aria-label={`Remove ${enemy.name}`}
        >
          ✕
        </button>
      </header>
      <div class="enemy-pools">
        <Pool enemy={enemy} pool="health" />
        <Pool enemy={enemy} pool="mind" />
      </div>
      <div class="enemy-stats">
        <RollInputs enemy={enemy} label="To hit" dice="hitDice" rank="hitRank" bonus="hitBonus" />
        <RollInputs enemy={enemy} label="Damage" dice="damageDice" rank="damageRank" bonus="damageBonus" />
        <div class="enemy-defs">
          {(['evasion', 'physicalResistance', 'mentalResistance', 'speed'] as const).map((key) => (
            <label>
              <span class="stat-label">{statDef(key).short}</span>
              <StatInput enemy={enemy} stat={key} />
            </label>
          ))}
        </div>
      </div>
      <textarea
        id={`en-${enemy.id}-description`}
        name="description"
        rows={2}
        maxlength={MAX_DESCRIPTION}
        placeholder="Special abilities, notes…"
        aria-label={`${enemy.name}: notes`}
        hx-post={`/gm/enemy/${enemy.id}/set`}
        hx-trigger="change"
      >
        {enemy.description}
      </textarea>
      {!down && <EnemyAttackForms session={props.session} enemy={enemy} />}
      <footer class="muted enemy-origin">
        {template ? `From ${template.name}${changed ? ' · tweaked' : ''}` : 'Template deleted'}
      </footer>
    </article>
  )
}

// ---- templates ----------------------------------------------------------------

function Templates(props: { session: Session }) {
  const { bestiary } = props.session
  const templates = bestiary.templates()
  return (
    <section class="enemy-templates">
      <header class="bestiary-head">
        <h2>Templates</h2>
        <span class="muted">Spawn copies into the encounter; editing a template doesn't change enemies already spawned.</span>
        <span class="spacer"></span>
        <button type="button" class="small primary" onclick="document.getElementById('tpl-new').showModal()">
          New template
        </button>
      </header>
      <div class="table-scroll">
        <table class="template-table">
          <thead>
            <tr>
              <th>Name</th>
              <th title="Health">HP</th>
              <th>Mind</th>
              <th>To hit</th>
              <th>Damage</th>
              <th title="Evasion">Ev</th>
              <th title="Physical resistance">Phys</th>
              <th title="Mental resistance">Ment</th>
              <th title="Speed">Spd</th>
              <th>Spawn</th>
              <th></th>
            </tr>
          </thead>
          {templates.map((t) => (
            <TemplateRows session={props.session} template={t} />
          ))}
        </table>
      </div>
      {templates.length === 0 && <p class="muted">No templates — add one with New template.</p>}
      <TemplateDialog id="tpl-new" title="New template" />
    </section>
  )
}

function TemplateRows(props: { session: Session; template: EnemyTemplate }) {
  const { template: t, session } = props
  const s = t.stats
  const edited = session.bestiary.isEdited(t.id)
  const custom = !session.bestiary.isBuiltin(t.id)
  const dialogId = `tpl-${t.id}`
  return (
    <tbody class="template-rows">
      <tr>
        <th scope="row" class="tpl-name">
          {t.name}
          {edited && <span class="badge">edited</span>}
          {custom && <span class="badge">custom</span>}
        </th>
        <td>{s.health}</td>
        <td>{s.mind}</td>
        <td class="nowrap">{rollLabel(s.hitDice, s.hitRank, s.hitBonus)}</td>
        <td class="nowrap">{rollLabel(s.damageDice, s.damageRank, s.damageBonus)}</td>
        <td>{s.evasion}</td>
        <td>{s.physicalResistance}</td>
        <td>{s.mentalResistance}</td>
        <td>{s.speed}</td>
        <td>
          <form class="spawn-form" hx-post={`/gm/bestiary/template/${t.id}/spawn`}>
            <input name="count" type="number" min={1} max={MAX_SPAWN} value={1} aria-label={`How many ${t.name}`} />
            <button type="submit" class="small">
              Spawn
            </button>
          </form>
        </td>
        <td class="nowrap tpl-actions">
          <button type="button" class="small" onclick={`document.getElementById('${dialogId}').showModal()`}>
            Edit
          </button>
          <button
            type="button"
            class="small danger"
            hx-post={`/gm/bestiary/template/${t.id}/delete`}
            hx-confirm={`Delete the ${t.name} template? Enemies already spawned from it stay.`}
          >
            Delete
          </button>
          <TemplateDialog id={dialogId} title={`Edit ${t.name}`} template={t} resettable={edited} />
        </td>
      </tr>
      {t.description && (
        <tr class="tpl-desc">
          <td colspan={11}>{t.description}</td>
        </tr>
      )}
    </tbody>
  )
}

/** The template form in a dialog: a new template (no `template`) or an edit of one. */
function TemplateDialog(props: { id: string; title: string; template?: EnemyTemplate; resettable?: boolean }) {
  const t = props.template
  const stats = t?.stats ?? AVERAGE
  const num = (key: EnemyStatKey) => {
    const def = statDef(key)
    return (
      <label>
        <span class="stat-label">{def.label}</span>
        <input name={key} type="number" step="1" min={def.min} max={def.max} value={stats[key]} required />
      </label>
    )
  }
  return (
    <dialog id={props.id} class="challenge-dialog template-dialog">
      <form hx-post="/gm/bestiary/template">
        <header class="dialog-head">
          <h3>{props.title}</h3>
          <button type="button" class="small" onclick="this.closest('dialog').close()">
            Close
          </button>
        </header>
        {t && <input type="hidden" name="id" value={t.id} />}
        <label>
          <span class="stat-label">Name</span>
          <input name="name" value={t?.name ?? ''} maxlength={MAX_NAME} required autocomplete="off" />
        </label>
        <div class="tpl-form-grid">
          {num('health')}
          {num('mind')}
        </div>
        <fieldset class="tpl-roll">
          <legend>To hit: dice d6 (rank) + bonus</legend>
          {num('hitDice')}
          {num('hitRank')}
          {num('hitBonus')}
        </fieldset>
        <fieldset class="tpl-roll">
          <legend>Damage: dice d6 (rank) + bonus</legend>
          {num('damageDice')}
          {num('damageRank')}
          {num('damageBonus')}
        </fieldset>
        <div class="tpl-form-grid">
          {num('evasion')}
          {num('physicalResistance')}
          {num('mentalResistance')}
          {num('speed')}
        </div>
        <label>
          <span class="stat-label">Description / special abilities</span>
          <textarea name="description" rows={4} maxlength={MAX_DESCRIPTION}>
            {t?.description ?? ''}
          </textarea>
        </label>
        <div class="dialog-actions">
          {props.resettable && t && (
            <button
              type="button"
              class="small"
              hx-post={`/gm/bestiary/template/${t.id}/reset`}
              hx-confirm={`Put ${t.name} back the way the rules file has it?`}
            >
              Reset to rules file
            </button>
          )}
          <button type="submit" class="primary">
            Save template
          </button>
        </div>
      </form>
    </dialog>
  )
}
