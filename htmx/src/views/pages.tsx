import { raw } from 'hono/html'
import type { Session } from '../session'
import { ChangeLog, Feed } from './feed'
import { Layout } from './layout'
import { Sheet } from './sheet'

export function JoinPage(props: { session: Session }) {
  const { session } = props
  const chars = [...session.characters.values()]
  return (
    <Layout title="Join the table" system={session.rules.name}>
      <main class="join">
        <h1>Who are you playing?</h1>
        {chars.length > 0 && (
          <form method="post" action="/join" class="char-list">
            {chars.map((c) => (
              <button name="charId" value={c.id}>
                {c.name}
              </button>
            ))}
          </form>
        )}
        <form method="post" action="/join" class="new-char">
          <input name="name" placeholder="New character name" maxlength={40} required />
          <button type="submit">Create</button>
        </form>
      </main>
    </Layout>
  )
}

export function PlayerPage(props: { session: Session; charId: string }) {
  const { session, charId } = props
  const char = session.characters.get(charId)!
  return (
    <Layout
      title={char.name}
      system={session.rules.name}
      who={<a href="/leave">{char.name} ⇄</a>}
      wsUrl={`/ws?char=${charId}`}
    >
      <main class="player-grid">
        <Sheet rules={session.rules} char={char} scope={session.scope(charId)} />
        <aside>
          <h3>Rolls</h3>
          <Feed rolls={session.recentRolls()} viewer="player" />
        </aside>
      </main>
    </Layout>
  )
}

export function GmPage(props: { session: Session; playerUrls: string[]; qrSvg: string }) {
  const { session } = props
  return (
    <Layout title="GM" system={session.rules.name} who="Game Master" wsUrl="/ws?gm=1" gm>
      <main class="gm-grid">
        <div class="gm-side">
          <details class="card">
            <summary>Players join at {props.playerUrls[0] ?? 'this laptop'}</summary>
            <div class="qr">{raw(props.qrSvg)}</div>
            {props.playerUrls.slice(1).map((u) => (
              <p class="muted">Also: {u}</p>
            ))}
          </details>

          <form
            class="card gm-roll"
            hx-post="/gm/roll"
            hx-target="next .error"
            hx-on--after-request="if (event.detail.successful && !event.detail.xhr.responseText) this.expr.value = ''"
          >
            <h3>GM roll</h3>
            <input name="label" placeholder="Label (optional)" autocomplete="off" />
            <input name="expr" placeholder="e.g. 3d6" autocomplete="off" required />
            <div class="visibility">
              <label>
                <input type="radio" name="visibility" value="public" checked /> Public
              </label>
              <label>
                <input type="radio" name="visibility" value="hidden" /> Secret (players see “GM rolled”)
              </label>
              <label>
                <input type="radio" name="visibility" value="gm" /> GM only
              </label>
            </div>
            <button type="submit">Roll</button>
          </form>
          <p class="error"></p>

          <h3>Rolls</h3>
          <Feed rolls={session.recentRolls()} viewer="gm" />

          <h3>Changes</h3>
          <ChangeLog session={session} />
        </div>

        <div id="sheets" class="sheets">
          {[...session.characters.values()].map((c) => (
            <Sheet rules={session.rules} char={c} scope={session.scope(c.id)} />
          ))}
        </div>
      </main>
    </Layout>
  )
}
