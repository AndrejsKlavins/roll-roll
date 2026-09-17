// Roll feed and GM change log.
import type { Rules } from '../rules'
import type { LoggedEvent, RollEvent, Session } from '../session'
import { formatNumber } from './sheet'

export type Viewer = 'player' | 'gm'

const time = (ts: number) =>
  new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

/** Returns null when the viewer must not see the roll at all. */
export function RollEntry(props: { roll: RollEvent; viewer: Viewer }) {
  const { roll, viewer } = props
  if (viewer === 'player' && roll.visibility === 'gm') return null
  if (viewer === 'player' && roll.visibility === 'hidden') {
    return (
      <div class="roll secret" data-sound="secret">
        <div class="roll-head">
          <b>GM</b> rolled in secret <time>{time(roll.ts)}</time>
        </div>
      </div>
    )
  }
  return (
    <div class={`roll vis-${roll.visibility}`} data-sound="roll">
      <div class="roll-head">
        <b>{roll.by}</b> <span>{roll.label}</span>
        {roll.visibility !== 'public' && <em class="badge">{roll.visibility === 'gm' ? 'GM only' : 'hidden'}</em>}
        <time>{time(roll.ts)}</time>
      </div>
      <div class="roll-body">
        <span class="total">{formatNumber(roll.total)}</span>
        <code>{roll.breakdown}</code>
      </div>
    </div>
  )
}

export function Feed(props: { session: Session; viewer: Viewer }) {
  return (
    <div id="feed" class="feed">
      {props.session
        .recentRolls()
        .reverse()
        .map((r) => (
          <RollEntry roll={r} viewer={props.viewer} />
        ))}
      <SessionMarker session={props.session} />
    </div>
  )
}

/** Divider at the bottom of the feed: everything above happened in this session. */
export function SessionMarker(props: { session: Session }) {
  const started = props.session.events.findLast((e) => e.type === 'session_started')
  if (!started) return null
  return (
    <div class="session-marker">
      Session {props.session.sessionNumber()} started <time>{time(started.ts)}</time>
    </div>
  )
}

function describeChange(e: LoggedEvent, session: Session, rules: Rules): string {
  if (e.type === 'session_started') return `${e.by} started session ${sessionIndex(e.id, session)}`
  if (e.type === 'character_renamed') return `${e.by} renamed ${e.from} → ${e.to}`
  if (e.type === 'character_deleted') return `${e.by} deleted ${session.names.get(e.charId) ?? 'a character'}`
  if (e.type === 'character_finalized') {
    const who = session.names.get(e.charId) ?? '?'
    return `${who} finished character creation${e.by !== who ? ` (by ${e.by})` : ''}`
  }
  if (e.type === 'base_set') {
    const who = session.names.get(e.charId) ?? '?'
    const label = rules.fields.get(e.field)?.label ?? e.field
    return `${who} · base ${label} ${e.from} → ${e.to}${e.by !== who ? ` (by ${e.by})` : ''}`
  }
  if (e.type === 'field_set') {
    const who = session.names.get(e.charId) ?? '?'
    const field = rules.fields.get(e.field)
    const label = field?.label ?? e.field
    const change = field?.type === 'text' ? 'edited' : `${e.from} → ${e.to}`
    return `${who} · ${label} ${change}${e.by !== who ? ` (by ${e.by})` : ''}`
  }
  if (e.type === 'undo') {
    const target = session.events.find((t) => t.id === e.target)
    const what = target ? describeChange(target, session, rules) : 'a change'
    return `${e.by} undid: ${what}`
  }
  return ''
}

const sessionIndex = (eventId: number, session: Session) =>
  session.events.filter((e) => e.type === 'session_started' && e.id <= eventId).length

export function ChangeLog(props: { session: Session; oob?: boolean }) {
  const { session } = props
  return (
    <ul id="changes" class="changes" hx-swap-oob={props.oob ? 'true' : undefined}>
      {session
        .recentChanges()
        .reverse()
        .map((e) => (
          <li class={session.isUndone(e.id) ? 'undone' : undefined}>
            <time>{time(e.ts)}</time> {describeChange(e, session, session.rules)}
          </li>
        ))}
    </ul>
  )
}
