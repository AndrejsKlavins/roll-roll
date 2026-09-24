import { raw } from 'hono/html'
import type { Character, Session } from '../session'
import {
  ChallengeBoard,
  ChallengeSetupDialog,
  GroupTaskBoard,
  GroupTaskDialog,
  OppositionBoard,
  OppositionDialog,
  SoloRollBoard,
  SoloRollDialog,
} from './challenge'
import { ConsequenceButtons, ConsequenceDialog } from './consequence'
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

export function WhoLink(props: { char: Character; oob?: boolean }) {
  return (
    <a id="who-link" href="/leave" hx-swap-oob={props.oob ? 'true' : undefined}>
      {props.char.name} ⇄
    </a>
  )
}

/** Replaces the player's page when the GM deletes their character. */
export function CharacterRemoved() {
  return (
    <main id="main" class="join" hx-swap-oob="true">
      <h1>Your character was removed</h1>
      <p class="muted">The GM deleted this character.</p>
      <a class="button" href="/leave">
        Choose another character
      </a>
    </main>
  )
}

export function PlayerPage(props: { session: Session; charId: string }) {
  const { session, charId } = props
  const char = session.characters.get(charId)!
  return (
    <Layout title={char.name} system={session.rules.name} who={<WhoLink char={char} />} wsUrl={`/ws?char=${charId}`}>
      <main id="main" class="player-grid">
        <Sheet session={session} char={char} />
        <aside>
          <ChallengeBoard session={session} role="player" viewerCharId={charId} />
          <OppositionBoard session={session} role="player" viewerCharId={charId} />
          <GroupTaskBoard session={session} role="player" viewerCharId={charId} />
          <SoloRollBoard session={session} role="player" />
          <h3>Rolls</h3>
          <Feed session={session} viewer="player" />
        </aside>
      </main>
    </Layout>
  )
}

/** The shared screen — no character, no interaction. Meant to sit on a TV/monitor at the table. */
export function TablePage(props: { session: Session }) {
  const { session } = props
  return (
    <Layout title="Table" system={session.rules.name} wsUrl="/ws?table=1">
      <main class="table-screen">
        <ChallengeBoard session={session} role="table" />
        <OppositionBoard session={session} role="table" />
        <GroupTaskBoard session={session} role="table" />
        <SoloRollBoard session={session} role="table" />
      </main>
    </Layout>
  )
}

export function SessionLabel(props: { session: Session; oob?: boolean }) {
  const n = props.session.sessionNumber()
  return (
    <strong id="session-label" hx-swap-oob={props.oob ? 'true' : undefined}>
      {n === 0 ? 'No session started yet' : `Session ${n}`}
    </strong>
  )
}

/**
 * GM backups: the whole event log out (JSON Lines) and back in — which replaces the game — and a
 * character CSV (exported from its sheet's Manage section) back in as a new character. Import
 * results land in the status line under each form.
 */
function BackupCard() {
  return (
    <details class="card backup-card">
      <summary>Backups</summary>
      <div class="backup-block">
        <h4>Session log</h4>
        <p class="muted">Everything so far — characters, rolls, challenges — as one file.</p>
        <a class="button small-link" href="/gm/log/export" download>
          Export session log
        </a>
        <form
          hx-post="/gm/log/import"
          hx-encoding="multipart/form-data"
          hx-target="next .backup-status"
          hx-confirm="Replace the whole game with this log? Everything now on the screens is swapped for what the file holds. (The current log is saved to the data folder first.)"
        >
          <input type="file" name="file" accept=".jsonl,.json,.txt" required />
          <button type="submit" class="small">
            Import session log
          </button>
        </form>
        <p class="backup-status" role="status"></p>
      </div>
      <div class="backup-block">
        <h4>Character</h4>
        <p class="muted">Export one from its sheet (Manage). Importing adds it as a new character.</p>
        <form hx-post="/gm/character/import" hx-encoding="multipart/form-data" hx-target="next .backup-status">
          <input type="file" name="file" accept=".csv,text/csv" required />
          <button type="submit" class="small">
            Import character
          </button>
        </form>
        <p class="backup-status" role="status"></p>
      </div>
    </details>
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

          <div class="card session-card">
            <SessionLabel session={session} />
            <button
              type="button"
              class="small"
              hx-post="/gm/session"
              hx-swap="none"
              hx-confirm="Start a new session? The roll feed and change log are cleared on every screen. Characters and history are kept."
            >
              Start new session
            </button>
          </div>

          {session.rules.traits.length > 0 && (
            <div class="card power-level-card">
              <span>
                Power level target <b id="power-level-value">{session.powerLevel}</b>
              </span>
              <form hx-post="/gm/power-level" hx-swap="none">
                <input name="value" type="number" step="1" value={session.powerLevel} aria-label="Power level target" />
                <button type="submit" class="small">
                  Set
                </button>
              </form>
            </div>
          )}

          <ConsequenceButtons session={session} />

          <a class="button" href="/table" target="_blank" rel="noopener">
            Open public table screen ↗
          </a>

          <BackupCard />
          <ChallengeBoard session={session} role="gm" />
          <OppositionBoard session={session} role="gm" />
          <GroupTaskBoard session={session} role="gm" />
          <SoloRollBoard session={session} role="gm" />
          <ChallengeSetupDialog session={session} />
          <SoloRollDialog session={session} />
          <ConsequenceDialog session={session} />
          <OppositionDialog session={session} />
          <GroupTaskDialog session={session} />

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
          <Feed session={session} viewer="gm" />

          <h3>Changes</h3>
          <ChangeLog session={session} />
        </div>

        <div id="sheets" class="sheets">
          {[...session.characters.values()].map((c) => (
            <Sheet session={session} char={c} gm />
          ))}
        </div>
      </main>
    </Layout>
  )
}
