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
import type { Derived, Field, NumberField } from '../rules'
import { isBaseField, type Character, type Session } from '../session'

const oobAttr = (oob?: boolean) => (oob ? 'true' : undefined)
export const fieldDomId = (charId: string, fieldId: string) => `f-${charId}-${fieldId}`

/** Root attributes for a field row: colour stripe via the --field-color custom property. */
const rowAttrs = (f: Field | Derived, cls: string) =>
  f.color ? { class: `${cls} has-color`, style: `--field-color: ${f.color}; --field-ink: ${f.ink}` } : { class: cls }

/** Icon chip (if configured) followed by the label content. */
function FieldName(props: { field: Field | Derived; children?: Child }) {
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

/** Shown value of a number field: word + dots for fields with a scale, otherwise the number. */
function ValueDisplay(props: { field: NumberField; value: number }) {
  const { field: f, value } = props
  if (!f.scale) return <>{String(value)}</> // a bare 0 child would render as nothing
  const dots = Math.max(0, Math.min(value, 10))
  return (
    <span class={value === 0 ? 'rating zero' : 'rating'}>
      <span class="rating-word">{f.scale[value] ?? String(value)}</span>
      <span class="dots" aria-hidden="true">
        {Array.from({ length: dots }, () => (
          <i></i>
        ))}
      </span>
    </span>
  )
}

const scaleWord = (f: NumberField, value: number) => f.scale?.[value] ?? String(value)

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

function BaseField(props: { session: Session; char: Character; field: NumberField; oob?: boolean }) {
  const { session, char, field: f } = props
  const post = `/c/${char.id}`
  const base = session.baseOf(char, f)
  const current = Number(session.valueOf(char, f))
  const modified = current !== base
  return (
    <div
      id={fieldDomId(char.id, f.id)}
      {...rowAttrs(f, modified ? 'field number based modified' : 'field number based')}
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
        <Stepper class="play" url={`${post}/adjust`} field={f} value={current} min={0} max={Infinity} />
        <Stepper class="base-edit" url={`${post}/adjust-base`} field={f} value={base} min={f.min} max={f.max} />
        <EditToggle field={f} />
      </div>
    </div>
  )
}

export function FieldView(props: { session: Session; char: Character; field: Field; oob?: boolean }) {
  const { session, char, field: f } = props
  const id = fieldDomId(char.id, f.id)
  const post = `/c/${char.id}`

  if (isBaseField(f) && char.status === 'active') return <BaseField {...props} field={f} />

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
  const editable = char.status === 'active' && !broken
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

/** GM-only: rename and delete. */
function ManageCharacter(props: { char: Character }) {
  const { char } = props
  return (
    <details class="manage">
      <summary>Manage</summary>
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
      x-data="{ editBase: false, open: {} }"
      x-bind:class="{ 'editing-base': editBase }"
    >
      <SheetHead session={session} char={char} />
      {props.gm && <ManageCharacter char={char} />}

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

      {rules.sections.map((s) => (
        <fieldset>
          <legend>{s.label}</legend>
          {s.fields.map((f) =>
            f.type === 'derived' ? (
              <DerivedRow session={session} char={char} derived={f} />
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
