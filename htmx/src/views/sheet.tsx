// Character sheet, generated entirely from rules.yaml.
// Each field and the derived block have stable ids so they can be swapped individually.
//
// Draft sheets edit values directly. Active sheets show base fields as "current (base N)";
// the "✎ Base" toggle (Alpine state on the <section>) swaps those steppers to edit the base.
//
// Number rows show just the value plus a per-row edit toggle; the steppers appear only while
// the row is open. Open rows live in the section's Alpine state (open.<fieldId>) so they stay
// open when the row itself is replaced by a live update.
import { raw } from 'hono/html'
import type { Child } from 'hono/jsx'
import type { Derived, Field, LevelItem, NumberField, Trait, TraitCategory } from '../rules'
import { isBaseField, MAX_TRAITS, PLAY_MAX, type Character, type Session } from '../session'

const oobAttr = (oob?: boolean) => (oob ? 'true' : undefined)
export const fieldDomId = (charId: string, fieldId: string) => `f-${charId}-${fieldId}`

/** Root attributes for a field row: colour stripe via the --field-color custom property. */
const rowAttrs = (f: Field | Derived | LevelItem, cls: string) =>
  f.color ? { class: `${cls} has-color`, style: `--field-color: ${f.color}; --field-ink: ${f.ink}` } : { class: cls }

/** Icon chip (if configured) followed by the label content. */
function FieldName(props: { field: Field | Derived | LevelItem; children?: Child }) {
  const { icon } = props.field
  return (
    <span class="field-name">
      {icon && (
        <span class="field-icon" aria-hidden="true">
          {icon.kind === 'svg' ? raw(icon.markup) : icon.kind === 'img' ? <img src={icon.src} alt="" /> : icon.text}
        </span>
      )}
      <span class="label">{props.children ?? props.field.label}</span>
    </span>
  )
}

/**
 * A field's value may scale past its scale's own entries (e.g. an ability boosted beyond 5, or
 * dropped below 1): clamp to the lowest/highest defined step so it still reads as a word
 * ("abysmal", "epic") instead of falling back to a bare number.
 */
function scaleWordAt(scale: Record<number, string>, value: number): string {
  const keys = Object.keys(scale).map(Number)
  const clamped = Math.max(Math.min(...keys), Math.min(Math.max(...keys), value))
  return scale[clamped] ?? String(value)
}

/** Shown value of a number field: word + dots for fields with a scale, otherwise the number. */
function ValueDisplay(props: { field: NumberField; value: number }) {
  const { field: f, value } = props
  if (!f.scale) return <>{String(value)}</> // a bare 0 child would render as nothing
  const dots = Math.max(0, Math.min(value, 10))
  // Declutter untrained (0) skills in the closed row; an ability at/below 0 still names itself.
  const hideWord = f.trained && value === 0
  return (
    <span class={hideWord ? 'rating zero' : 'rating'}>
      <span class="rating-word">{scaleWordAt(f.scale, value)}</span>
      <span class="dots" aria-hidden="true">
        {Array.from({ length: dots }, () => (
          <i></i>
        ))}
      </span>
    </span>
  )
}

const scaleWord = (f: NumberField, value: number) => (f.scale ? scaleWordAt(f.scale, value) : String(value))

function Stepper(props: {
  class: string
  url: string
  field: NumberField
  value: number
  min: number
  max: number
}) {
  const step = (delta: number) => JSON.stringify({ field: props.field.id, delta })
  return (
    <div class={`stepper ${props.class}`}>
      <button
        type="button"
        hx-post={props.url}
        hx-vals={step(-1)}
        hx-swap="none"
        disabled={props.value <= props.min || undefined}
      >
        −
      </button>
      <output>
        <ValueDisplay field={props.field} value={props.value} />
      </output>
      <button
        type="button"
        hx-post={props.url}
        hx-vals={step(1)}
        hx-swap="none"
        disabled={props.value >= props.max || undefined}
      >
        +
      </button>
    </div>
  )
}

/** Pencil ↔ check button that opens/closes a number row's steppers. */
function EditToggle(props: { field: Field | Derived }) {
  const key = `open.${props.field.id}`
  return (
    <button
      type="button"
      class="edit-toggle"
      x-on:click={`${key} = !${key}`}
      x-text={`${key} ? '✓' : '✎'`}
      x-bind:aria-pressed={`!!${key}`}
      aria-label={`Edit ${props.field.label}`}
    >
      ✎
    </button>
  )
}

/** x-bind:class for a number row: "editing" while its steppers are open. */
const editingClass = (f: Field | Derived) => `{ editing: open.${f.id} }`

/**
 * Training mode panel for a trained field: one row of circles per rank (4, 5, 6, … points),
 * filled in order as points are assigned, plus − / + to take back or assign one point.
 */
function TrainPanel(props: { session: Session; char: Character; field: NumberField }) {
  const { session, char, field: f } = props
  const t = session.rules.training!
  const points = char.skillPoints[f.id] ?? 0
  const available = session.availablePoints(char)
  const rankWord = (r: number) => f.scale?.[r] ?? `rank ${r}`
  const step = (delta: number) => JSON.stringify({ skill: f.id, delta })
  return (
    <div class="train-panel">
      <div class="train-controls">
        <button
          type="button"
          hx-post={`/c/${char.id}/train`}
          hx-vals={step(-1)}
          hx-swap="none"
          disabled={points <= 0 || undefined}
          aria-label={`Take a point back from ${f.label}`}
        >
          −
        </button>
        <button
          type="button"
          hx-post={`/c/${char.id}/train`}
          hx-vals={step(1)}
          hx-swap="none"
          disabled={available <= 0 || points >= t.maxPoints || undefined}
          aria-label={`Assign a point to ${f.label}`}
        >
          +
        </button>
      </div>
      {t.rankCosts.map((cost, i) => {
        const filled = Math.max(0, Math.min(cost, points - (t.thresholds[i]! - cost)))
        return (
          <div class={filled === cost ? 'rank-row done' : 'rank-row'}>
            <span class="rank-name">{rankWord(i + 1)}</span>
            <span class="pool">
              {Array.from({ length: cost }, (_, n) => (
                <i class={n < filled ? 'full' : undefined}></i>
              ))}
            </span>
          </div>
        )
      })}
    </div>
  )
}

/** Level counter with a Level up button (finished characters only). */
export function LevelRow(props: { session: Session; char: Character; item: LevelItem; oob?: boolean }) {
  const { session, char, item } = props
  const active = char.status === 'active'
  return (
    <div
      id={`lvl-${char.id}`}
      {...rowAttrs(item, active ? 'field level' : 'field level readonly')}
      hx-swap-oob={oobAttr(props.oob)}
    >
      <FieldName field={item} />
      <div class="field-controls">
        <output class="value">{String(char.level)}</output>
        {active && (
          <button
            type="button"
            class="small level-up"
            hx-post={`/c/${char.id}/level-up`}
            hx-swap="none"
            hx-confirm={`Level up ${char.name} to level ${char.level + 1}? Gains ${session.pointsPerLevel(char)} skill points.`}
          >
            Level up
          </button>
        )}
      </div>
    </div>
  )
}

/** Skill points available + Train toggle, shown at the top of sections with trained fields. */
export function TrainBar(props: { session: Session; char: Character; oob?: boolean }) {
  const available = props.session.availablePoints(props.char)
  return (
    <div id={`train-bar-${props.char.id}`} class="train-bar" hx-swap-oob={oobAttr(props.oob)}>
      <span class={available < 0 ? 'available negative' : 'available'}>
        Skill points <b>{available}</b>
      </span>
      <button type="button" class="small" x-on:click="training = !training" x-text="training ? 'Done' : 'Train'">
        Train
      </button>
    </div>
  )
}

function BaseField(props: { session: Session; char: Character; field: NumberField; oob?: boolean }) {
  const { session, char, field: f } = props
  const post = `/c/${char.id}`
  const base = session.baseOf(char, f)
  const current = Number(session.valueOf(char, f))
  const modified = current !== base
  return (
    <div
      id={fieldDomId(char.id, f.id)}
      {...rowAttrs(f, ['field number based', modified && 'modified', f.trained && 'trained'].filter(Boolean).join(' '))}
      x-bind:class={editingClass(f)}
      hx-swap-oob={oobAttr(props.oob)}
    >
      <FieldName field={f}>
        {f.label}
        <small class="base-note">
          base {scaleWord(f, base)}
          {modified && (
            <button
              type="button"
              class="link"
              hx-post={`${post}/set`}
              hx-vals={JSON.stringify({ field: f.id, value: base })}
              hx-swap="none"
            >
              reset
            </button>
          )}
        </small>
      </FieldName>
      <div class="field-controls">
        {modified && (
          <span class="delta" title={`base ${scaleWord(f, base)}`}>
            {current > base ? '▲' : '▼'}
          </span>
        )}
        <output class="value">
          <ValueDisplay field={f} value={current} />
        </output>
        <Stepper class="play" url={`${post}/adjust`} field={f} value={current} min={f.min} max={Math.max(f.max, PLAY_MAX)} />
        {!f.trained && (
          <Stepper class="base-edit" url={`${post}/adjust-base`} field={f} value={base} min={f.min} max={f.max} />
        )}
        <EditToggle field={f} />
      </div>
      {f.trained && session.rules.training && <TrainPanel session={session} char={char} field={f} />}
    </div>
  )
}

export function FieldView(props: { session: Session; char: Character; field: Field; oob?: boolean }) {
  const { session, char, field: f } = props
  const id = fieldDomId(char.id, f.id)
  const post = `/c/${char.id}`

  if (isBaseField(f) && char.status === 'active') return <BaseField {...props} field={f} />
  if (isBaseField(f) && f.trained) {
    const rank = session.baseOf(char, f)
    return (
      <div id={id} {...rowAttrs(f, 'field number trained readonly')} hx-swap-oob={oobAttr(props.oob)}>
        <FieldName field={f} />
        <div class="field-controls">
          <output class="value">
            <ValueDisplay field={f} value={rank} />
          </output>
        </div>
      </div>
    )
  }

  if (f.type === 'text') {
    return (
      <label id={id} {...rowAttrs(f, 'field text')} hx-swap-oob={oobAttr(props.oob)}>
        <FieldName field={f} />
        <textarea
          name="value"
          rows={f.lines}
          hx-post={`${post}/set`}
          hx-trigger="change"
          hx-vals={JSON.stringify({ field: f.id })}
          hx-swap="none"
        >
          {session.valueOf(char, f)}
        </textarea>
      </label>
    )
  }

  const value = Number(session.valueOf(char, f))

  if (f.type === 'track') {
    return (
      <div id={id} {...rowAttrs(f, 'field track')} hx-swap-oob={oobAttr(props.oob)}>
        <FieldName field={f} />
        <div class="pips">
          {Array.from({ length: f.max }, (_, i) => i + 1).map((n) => (
            <button
              type="button"
              class={n <= value ? 'pip on' : 'pip'}
              hx-post={`${post}/set`}
              hx-vals={JSON.stringify({ field: f.id, value: n === value ? n - 1 : n })}
              hx-swap="none"
              aria-label={`${f.label} ${n}`}
            ></button>
          ))}
          <output>
            {value}/{f.max}
          </output>
        </div>
      </div>
    )
  }

  return (
    <div id={id} {...rowAttrs(f, 'field number')} x-bind:class={editingClass(f)} hx-swap-oob={oobAttr(props.oob)}>
      <FieldName field={f} />
      <div class="field-controls">
        <output class="value">
          <ValueDisplay field={f} value={value} />
        </output>
        <Stepper class="play" url={`${post}/adjust`} field={f} value={value} min={f.min} max={f.max} />
        <EditToggle field={f} />
      </div>
    </div>
  )
}

const derivedText = (v: number | undefined) => (v === undefined || Number.isNaN(v) ? 'err' : formatNumber(v))

/** Pool stat: one circle per point of maximum, filled for what is left. */
function PoolCircles(props: { current: number; max: number }) {
  const max = Math.max(0, Math.min(props.max, 40))
  return (
    <span class="pool" aria-label={`${props.current} of ${props.max}`}>
      {Array.from({ length: max }, (_, i) => (
        <i class={i < props.current ? 'full' : undefined}></i>
      ))}
    </span>
  )
}

/**
 * A calculated value placed inside a section. Shows a number (or circles for pools); finished
 * characters get the same ✎ toggle as editable rows to apply play changes on top of the formula.
 */
export function DerivedRow(props: { session: Session; char: Character; derived: Derived; oob?: boolean }) {
  const { session, char, derived: d } = props
  const stat = session.statOf(char, d.id)!
  const broken = Number.isNaN(session.scope(char.id)[d.id] ?? NaN)
  const editable = char.status === 'active' && !broken && !d.useBase
  const modified = stat.current !== stat.normal
  const post = `/c/${char.id}`
  const step = (delta: number) => JSON.stringify({ stat: d.id, delta })
  const shown = broken ? 'err' : d.pool ? <PoolCircles current={stat.current} max={stat.normal} /> : formatNumber(stat.current)
  const cls = ['field stat', d.pool && 'pool-stat', modified && 'modified', !editable && 'readonly'].filter(Boolean).join(' ')
  return (
    <div
      id={`dv-${char.id}-${d.id}`}
      {...rowAttrs(d, cls)}
      x-bind:class={editable ? editingClass(d) : undefined}
      title={d.formula}
      hx-swap-oob={oobAttr(props.oob)}
    >
      <FieldName field={d}>
        {d.label}
        {editable && modified && (
          <small class="base-note">
            {d.pool ? `${stat.current} of ${stat.normal}` : `normal ${formatNumber(stat.normal)}`}
            <button
              type="button"
              class="link"
              hx-post={`${post}/set-stat`}
              hx-vals={JSON.stringify({ stat: d.id, value: stat.normal })}
              hx-swap="none"
            >
              {d.pool ? 'restore' : 'reset'}
            </button>
          </small>
        )}
      </FieldName>
      <div class="field-controls">
        {!d.pool && modified && (
          <span class="delta" title={`normal ${formatNumber(stat.normal)}`}>
            {stat.current > stat.normal ? '▲' : '▼'}
          </span>
        )}
        <output class="value">{shown}</output>
        {editable && (
          <div class="stepper play">
            <button
              type="button"
              hx-post={`${post}/adjust-stat`}
              hx-vals={step(-1)}
              hx-swap="none"
              disabled={stat.current <= 0 || undefined}
            >
              −
            </button>
            <output>{shown}</output>
            <button
              type="button"
              hx-post={`${post}/adjust-stat`}
              hx-vals={step(1)}
              hx-swap="none"
              disabled={(d.pool && stat.current >= stat.normal) || undefined}
            >
              +
            </button>
          </div>
        )}
        {editable && <EditToggle field={d} />}
      </div>
    </div>
  )
}

/**
 * All calculated values for a character, as out-of-band updates: every in-section row plus
 * the compact block for top-level derived values. Any field change can affect any of them.
 */
export function DerivedUpdates(props: { session: Session; char: Character }) {
  return (
    <>
      {props.session.rules.derived
        .filter((d) => d.inSection)
        .map((d) => (
          <DerivedRow session={props.session} char={props.char} derived={d} oob />
        ))}
      <DerivedView session={props.session} char={props.char} oob />
    </>
  )
}

/** Compact block for derived values not placed in any section. */
export function DerivedView(props: { session: Session; char: Character; oob?: boolean }) {
  const loose = props.session.rules.derived.filter((d) => !d.inSection)
  if (loose.length === 0) return null
  const scope = props.session.scope(props.char.id)
  return (
    <dl id={`derived-${props.char.id}`} class="derived" hx-swap-oob={oobAttr(props.oob)}>
      {loose.map((d) => {
        const v = scope[d.id]
        return (
          <div title={d.formula}>
            <dt>{d.label}</dt>
            <dd>{derivedText(v)}</dd>
          </div>
        )
      })}
    </dl>
  )
}

const signed = (n: number) => (n === 0 ? '0' : n > 0 ? `+${n}` : String(n))

/** One picked trait: title, cost (right-aligned) and remove button, then its description. */
function TraitBlock(props: { char: Character; trait: Trait }) {
  const { char, trait: t } = props
  return (
    <li class="trait-block">
      <div class="trait-block-head">
        <span class="trait-title">{t.label}</span>
        <b class={t.cost < 0 ? 'cost buff' : t.cost > 0 ? 'cost flaw' : 'cost neutral'}>{signed(t.cost)}</b>
        <button
          type="button"
          class="small link"
          hx-post={`/c/${char.id}/trait/remove`}
          hx-vals={JSON.stringify({ trait: t.id })}
          hx-swap="none"
        >
          remove
        </button>
      </div>
      <p class="trait-desc">{t.description}</p>
    </li>
  )
}

/** One category's picked traits, shown only once it has at least one. */
function TraitCategoryBlock(props: { session: Session; char: Character; category: TraitCategory }) {
  const { session, char, category } = props
  const chosen = session.traitsInCategory(char, category.id)
  if (chosen.length === 0) return null
  return (
    <div class="trait-category">
      <h4 class="trait-category-label">{category.label}</h4>
      <ul class="trait-list">
        {chosen.map((t) => (
          <TraitBlock char={char} trait={t} />
        ))}
      </ul>
    </div>
  )
}

/**
 * "Add Trait" opens a dialog: step 1 lists categories that still have room (as buttons), step 2
 * lists that category's remaining traits (as buttons, with cost and description), or back.
 * Picking one submits it; the dialog closes itself because the whole section, dialog included,
 * gets replaced by the live update that follows (fresh Alpine state = closed).
 */
function AddTraitDialog(props: { session: Session; char: Character }) {
  const { session, char } = props
  const { rules } = session
  if (char.traits.length >= MAX_TRAITS) return <p class="muted small">Maximum {MAX_TRAITS} traits picked.</p>
  const addable = rules.traitCategories
    .map((category) => ({
      category,
      options: rules.traits.filter((t) => t.category === category.id && !char.traits.includes(t.id)),
    }))
    .filter(({ category, options }) => options.length > 0 && session.traitsInCategory(char, category.id).length < category.max)
  if (addable.length === 0) return null
  return (
    <div class="trait-add" x-data="{ open: false, cat: null }">
      <button type="button" x-on:click="open = true; cat = null">
        + Add Trait
      </button>
      <div class="trait-dialog-backdrop" x-show="open" x-cloak x-on:click="open = false"></div>
      <div class="trait-dialog" x-show="open" x-cloak role="dialog" aria-modal="true" aria-label="Add a trait">
        <div class="trait-dialog-step" x-show="!cat" x-cloak>
          <div class="trait-dialog-head">
            <span>Choose a category</span>
            <button type="button" class="icon" x-on:click="open = false" aria-label="Close">
              ✕
            </button>
          </div>
          <div class="trait-dialog-options">
            {addable.map(({ category }) => (
              <button type="button" x-on:click={`cat = ${JSON.stringify(category.id)}`}>
                {category.label}
              </button>
            ))}
          </div>
        </div>
        {addable.map(({ category, options }) => (
          <div class="trait-dialog-step" x-show={`cat === ${JSON.stringify(category.id)}`} x-cloak>
            <div class="trait-dialog-head">
              <button type="button" class="small link" x-on:click="cat = null">
                ← Back
              </button>
              <span>{category.label}</span>
              <button type="button" class="icon" x-on:click="open = false" aria-label="Close">
                ✕
              </button>
            </div>
            <div class="trait-dialog-options">
              {options.map((t) => (
                <button
                  type="button"
                  class="trait-choice"
                  hx-post={`/c/${char.id}/trait/add`}
                  hx-vals={JSON.stringify({ trait: t.id })}
                  hx-swap="none"
                >
                  <span class="trait-choice-head">
                    <b>{t.label}</b>
                    <em class={t.cost < 0 ? 'cost buff' : t.cost > 0 ? 'cost flaw' : 'cost neutral'}>{signed(t.cost)}</em>
                  </span>
                  <span class="trait-choice-desc">{t.description}</span>
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

/**
 * Traits picked at creation (or later, if allowed): each nudges a bundle of abilities, grouped
 * by category. The cost total vs. the GM's power level is shown for reference only — nothing
 * here is enforced (category and overall picks caps are, via AddTraitDialog).
 */
export function TraitsSection(props: { session: Session; char: Character; oob?: boolean }) {
  const { session, char } = props
  const { rules } = session
  if (rules.traits.length === 0) return null
  const sum = session.traitCost(char)
  const target = session.powerLevel
  return (
    <fieldset id={`traits-${char.id}`} class="traits" hx-swap-oob={oobAttr(props.oob)}>
      <legend>Traits</legend>
      <div class="trait-budget">
        <span class={sum === target ? 'budget ok' : 'budget off'}>
          Selected trait total value {signed(sum)} / Required trait total value {signed(target)}
        </span>
      </div>
      {rules.traitCategories.map((cat) => (
        <TraitCategoryBlock session={session} char={char} category={cat} />
      ))}
      <AddTraitDialog session={session} char={char} />
    </fieldset>
  )
}

const hasBaseFields = (session: Session) => [...session.rules.fields.values()].some(isBaseField)

export function SheetHead(props: { session: Session; char: Character; oob?: boolean }) {
  const { session, char } = props
  return (
    <div id={`head-${char.id}`} class="sheet-head" hx-swap-oob={oobAttr(props.oob)}>
      <h2>
        {char.name}
        {char.status === 'draft' && <em class="badge draft">In creation</em>}
      </h2>
      {char.status === 'active' && (
        <div class="head-actions">
          {hasBaseFields(session) && (
            <button
              type="button"
              class="small"
              x-on:click="editBase = !editBase"
              x-text="editBase ? 'Done' : '✎ Base'"
              title="Edit base values"
            >
              ✎ Base
            </button>
          )}
          <button type="button" class="small" hx-post={`/c/${char.id}/undo`} hx-swap="none" title="Undo last change">
            ↶ Undo
          </button>
        </div>
      )}
    </div>
  )
}

/** GM-only line in Manage: level and skill points, kept current by live updates. */
export function ManagePoints(props: { session: Session; char: Character; oob?: boolean }) {
  const { session, char } = props
  return (
    <span id={`manage-points-${char.id}`} hx-swap-oob={oobAttr(props.oob)}>
      Level {char.level} · {session.availablePoints(char)} skill points available ·{' '}
      {session.pointsPerLevel(char)} per level
    </span>
  )
}

/** GM-only: skill point grants, rename and delete. */
function ManageCharacter(props: { session: Session; char: Character }) {
  const { session, char } = props
  const training = session.rules.training && char.status === 'active'
  return (
    <details class="manage">
      <summary>Manage</summary>
      {training && (
        <div class="manage-points">
          <ManagePoints session={session} char={char} />
          <div class="manage-actions">
            <form class="grant" hx-post={`/c/${char.id}/grant-points`} hx-swap="none">
              <input name="amount" type="number" value="1" step="1" aria-label="Skill points to give" />
              <button type="submit" class="small">
                Give points
              </button>
            </form>
          </div>
        </div>
      )}
      <form class="rename" hx-post={`/c/${char.id}/rename`} hx-swap="none">
        <input name="name" value={char.name} maxlength={40} required autocomplete="off" />
        <button type="submit">Rename</button>
      </form>
      <button
        type="button"
        class="danger"
        hx-post={`/c/${char.id}/delete`}
        hx-swap="none"
        hx-confirm={`Delete ${char.name}? The player is sent back to character selection. This cannot be undone.`}
      >
        Delete character
      </button>
    </details>
  )
}

export function Sheet(props: { session: Session; char: Character; gm?: boolean; oob?: boolean }) {
  const { session, char } = props
  const { rules } = session
  const draft = char.status === 'draft'
  return (
    <section
      id={`sheet-${char.id}`}
      class="sheet"
      hx-swap-oob={oobAttr(props.oob)}
      x-data="{ editBase: false, open: {}, training: false }"
      x-bind:class="{ 'editing-base': editBase, training: training }"
    >
      <SheetHead session={session} char={char} />
      {props.gm && <ManageCharacter session={session} char={char} />}

      {draft ? (
        <p class="stage-note">In creation: set values freely, nothing is logged. Finish at the bottom when ready.</p>
      ) : (
        <div class="base-banner" x-show="editBase" x-cloak>
          <span>Editing base values. Changes are logged.</span>
          <button type="button" class="small" x-on:click="editBase = false">
            Done
          </button>
        </div>
      )}

      <TraitsSection session={session} char={char} />

      {rules.sections.map((s) => (
        <fieldset>
          <legend>{s.label}</legend>
          {session.rules.training &&
            s.fields.some((f) => f.type === 'number' && f.trained) &&
            (draft ? (
              <p class="stage-note">Skills are trained with skill points once the character is finished.</p>
            ) : (
              <TrainBar session={session} char={char} />
            ))}
          {s.fields.map((f) =>
            f.type === 'derived' ? (
              <DerivedRow session={session} char={char} derived={f} />
            ) : f.type === 'level' ? (
              <LevelRow session={session} char={char} item={f} />
            ) : (
              <FieldView session={session} char={char} field={f} />
            ),
          )}
        </fieldset>
      ))}

      <DerivedView session={session} char={char} />

      {draft ? (
        <div class="finish">
          <button
            type="button"
            class="primary"
            hx-post={`/c/${char.id}/finalize`}
            hx-swap="none"
            hx-confirm={`Finish ${char.name}? Current abilities and skills become base values, and changes from now on are logged.`}
          >
            Finish character
          </button>
        </div>
      ) : (
        <>
          <div class="rolls">
            {rules.rolls.map((r) => (
              <button
                type="button"
                class="roll-btn"
                hx-post={`/c/${char.id}/roll`}
                hx-vals={JSON.stringify({ roll: r.id })}
                hx-swap="none"
                title={r.dice}
              >
                {r.label}
              </button>
            ))}
          </div>

          <form
            class="free-roll"
            hx-post={`/c/${char.id}/roll-free`}
            hx-target="next .error"
            hx-on--after-request="if (event.detail.successful && !event.detail.xhr.responseText) this.reset()"
          >
            <input name="expr" placeholder="Free roll, e.g. 2d6+1" autocomplete="off" required />
            <button type="submit">Roll</button>
          </form>
          <p class="error"></p>
        </>
      )}
    </section>
  )
}

export function formatNumber(n: number) {
  return Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/\.?0+$/, '')
}
