// Character sheet, generated entirely from rules.yaml.
// Each field and the derived block have stable ids so they can be swapped individually.
//
// Draft sheets edit values directly. Active sheets show base fields as "current (base N)";
// the "✎ Base" toggle (Alpine state on the <section>) swaps those steppers to edit the base.
import { raw } from 'hono/html'
import type { Child } from 'hono/jsx'
import type { Field, NumberField } from '../rules'
import { isBaseField, type Character, type Session } from '../session'

const oobAttr = (oob?: boolean) => (oob ? 'true' : undefined)
export const fieldDomId = (charId: string, fieldId: string) => `f-${charId}-${fieldId}`

/** Root attributes for a field row: colour stripe via the --field-color custom property. */
const rowAttrs = (f: Field, cls: string) =>
  f.color ? { class: `${cls} has-color`, style: `--field-color: ${f.color}` } : { class: cls }

/** Icon chip (if configured) followed by the label content. */
function FieldName(props: { field: Field; children?: Child }) {
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

function Stepper(props: {
  class: string
  url: string
  field: string
  value: number
  min: number
  max: number
}) {
  const step = (delta: number) => JSON.stringify({ field: props.field, delta })
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
      <output>{props.value}</output>
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
      hx-swap-oob={oobAttr(props.oob)}
    >
      <FieldName field={f}>
        {f.label}
        <small class="base-note">
          base {base}
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
      <Stepper class="play" url={`${post}/adjust`} field={f.id} value={current} min={0} max={Infinity} />
      <Stepper class="base-edit" url={`${post}/adjust-base`} field={f.id} value={base} min={f.min} max={f.max} />
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
    <div id={id} {...rowAttrs(f, 'field number')} hx-swap-oob={oobAttr(props.oob)}>
      <FieldName field={f} />
      <Stepper class="" url={`${post}/adjust`} field={f.id} value={value} min={f.min} max={f.max} />
    </div>
  )
}

export function DerivedView(props: { session: Session; char: Character; oob?: boolean }) {
  const { rules } = props.session
  if (rules.derived.length === 0) return null
  const scope = props.session.scope(props.char.id)
  return (
    <dl id={`derived-${props.char.id}`} class="derived" hx-swap-oob={oobAttr(props.oob)}>
      {rules.derived.map((d) => {
        const v = scope[d.id]
        return (
          <div title={d.formula}>
            <dt>{d.label}</dt>
            <dd>{v === undefined || Number.isNaN(v) ? 'err' : formatNumber(v)}</dd>
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
      x-data="{ editBase: false }"
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
          {s.fields.map((f) => (
            <FieldView session={session} char={char} field={f} />
          ))}
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
