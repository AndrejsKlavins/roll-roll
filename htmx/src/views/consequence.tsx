// Boons and complications: the GM's two buttons, the small dialog they open (rank, then Roll /
// Reroll), and the result the server sends back into it. GM screen only; nothing is logged.
import type { Session } from '../session'

type Kind = 'boon' | 'complication'

/** Opens the dialog on `kind`, with no result showing yet. */
const openScript = (kind: Kind) =>
  [
    "const d = document.getElementById('consequence-dialog');",
    `Object.assign(Alpine.$data(d), { kind: '${kind}', rolled: false });`,
    "d.querySelector('#consequence-result').innerHTML = '';",
    'd.showModal()',
  ].join(' ')

/** The GM's "Roll boon" / "Roll complication" buttons, when the rules file has the tables. */
export function ConsequenceButtons(props: { session: Session }) {
  if (!props.session.rules.consequences) return null
  return (
    <div class="card consequence-card">
      <button type="button" class="small consequence-open boon" onclick={openScript('boon')}>
        Roll boon
      </button>
      <button type="button" class="small consequence-open complication" onclick={openScript('complication')}>
        Roll complication
      </button>
    </div>
  )
}

/**
 * The dialog: pick a rank (1 … the table's ranks), then **Roll**; once a result is showing the
 * button reads **Reroll** and rolls again straight away. Changing the rank turns it back to Roll.
 * The kind and rank are Alpine state; the result is server-rendered into #consequence-result.
 */
export function ConsequenceDialog(props: { session: Session }) {
  const config = props.session.rules.consequences
  if (!config) return null
  const ranks = Array.from({ length: config.ranks }, (_, i) => i + 1)
  return (
    <dialog id="consequence-dialog" class="challenge-dialog consequence-dialog" x-data="{ kind: 'boon', rank: 1, rolled: false }">
      <form
        hx-post="/gm/consequence/roll"
        hx-target="#consequence-result"
        hx-swap="innerHTML"
        hx-on--after-request="if (event.detail.successful) Alpine.$data(this).rolled = true"
      >
        <header class="dialog-head">
          <h3 x-text="kind === 'boon' ? 'Roll a boon' : 'Roll a complication'">Roll a boon</h3>
          <button type="button" class="small" x-on:click="$el.closest('dialog').close()">
            Close
          </button>
        </header>
        <section class="side-pick">
          <h4>Rank</h4>
          <div class="consequence-ranks">
            {ranks.map((r) => (
              <button
                type="button"
                class="pick-btn"
                x-bind:class={`{ on: rank === ${r} }`}
                x-on:click={`rank = ${r}; rolled = false`}
              >
                <span class="label">{r}</span>
              </button>
            ))}
          </div>
        </section>
        <input type="hidden" name="kind" x-bind:value="kind" />
        <input type="hidden" name="rank" x-bind:value="rank" />
        <div id="consequence-result" class="consequence-result-slot" aria-live="polite"></div>
        <button type="submit" class="primary" x-text="rolled ? 'Reroll' : 'Roll'">
          Roll
        </button>
      </form>
    </dialog>
  )
}

/** What a roll came up with: the die and face, the entry's name, its text, and kind · rank. */
export function ConsequenceResult(props: {
  kind: Kind
  label: string
  rank: number
  sides: number
  face: number
  entry: { title: string; text: string }
}) {
  const { kind, entry } = props
  return (
    <div class={`consequence-result ${kind}`}>
      <div class="consequence-die">
        d{props.sides} rolled <b>{props.face}</b>
      </div>
      <div class="consequence-title">{entry.title}</div>
      {entry.text && <p class="consequence-text">{entry.text}</p>}
      <div class="consequence-meta">
        {props.label} · rank {props.rank}
      </div>
    </div>
  )
}
