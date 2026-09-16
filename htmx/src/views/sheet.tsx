// Character sheet, generated entirely from rules.yaml.
// Each field and the derived block have stable ids so they can be swapped individually.
import type { Field, Rules } from '../rules'
import type { Character } from '../session'

const oobAttr = (oob?: boolean) => (oob ? 'true' : undefined)
export const fieldDomId = (charId: string, fieldId: string) => `f-${charId}-${fieldId}`

export function FieldView(props: { char: Character; field: Field; oob?: boolean }) {
  const { char, field: f } = props
  const id = fieldDomId(char.id, f.id)
  const post = `/c/${char.id}`

  if (f.type === 'text') {
    return (
      <label id={id} class="field text" hx-swap-oob={oobAttr(props.oob)}>
        <span>{f.label}</span>
        <textarea
          name="value"
          rows={f.lines}
          hx-post={`${post}/set`}
          hx-trigger="change"
          hx-vals={JSON.stringify({ field: f.id })}
          hx-swap="none"
        >
          {String(char.values[f.id] ?? '')}
        </textarea>
      </label>
    )
  }

  const value = Number(char.values[f.id] ?? f.default)

  if (f.type === 'track') {
    return (
      <div id={id} class="field track" hx-swap-oob={oobAttr(props.oob)}>
        <span>{f.label}</span>
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
    <div id={id} class="field number" hx-swap-oob={oobAttr(props.oob)}>
      <span>{f.label}</span>
      <div class="stepper">
        <button
          type="button"
          hx-post={`${post}/adjust`}
          hx-vals={JSON.stringify({ field: f.id, delta: -1 })}
          hx-swap="none"
          disabled={value <= f.min || undefined}
        >
          −
        </button>
        <output>{value}</output>
        <button
          type="button"
          hx-post={`${post}/adjust`}
          hx-vals={JSON.stringify({ field: f.id, delta: 1 })}
          hx-swap="none"
          disabled={value >= f.max || undefined}
        >
          +
        </button>
      </div>
    </div>
  )
}

export function DerivedView(props: { rules: Rules; char: Character; scope: Record<string, number>; oob?: boolean }) {
  if (props.rules.derived.length === 0) return null
  return (
    <dl id={`derived-${props.char.id}`} class="derived" hx-swap-oob={oobAttr(props.oob)}>
      {props.rules.derived.map((d) => {
        const v = props.scope[d.id]
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

export function SheetHead(props: { char: Character; oob?: boolean }) {
  const { char } = props
  return (
    <div id={`head-${char.id}`} class="sheet-head" hx-swap-oob={oobAttr(props.oob)}>
      <h2>{char.name}</h2>
      <button type="button" class="small" hx-post={`/c/${char.id}/undo`} hx-swap="none" title="Undo last change">
        ↶ Undo
      </button>
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

export function Sheet(props: {
  rules: Rules
  char: Character
  scope: Record<string, number>
  gm?: boolean
  oob?: boolean
}) {
  const { rules, char } = props
  return (
    <section id={`sheet-${char.id}`} class="sheet" hx-swap-oob={oobAttr(props.oob)}>
      <SheetHead char={char} />
      {props.gm && <ManageCharacter char={char} />}

      {rules.sections.map((s) => (
        <fieldset>
          <legend>{s.label}</legend>
          {s.fields.map((f) => (
            <FieldView char={char} field={f} />
          ))}
        </fieldset>
      ))}

      <DerivedView rules={rules} char={char} scope={props.scope} />

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
    </section>
  )
}

export function formatNumber(n: number) {
  return Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/\.?0+$/, '')
}
