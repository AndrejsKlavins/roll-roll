// In-game clock at the top of the table screen. The server sends game time as of the moment it
// renders; public/app.js counts on from there while it runs (no server/device clock sync needed).
import type { Session } from '../session'

const DAY_MS = 24 * 60 * 60 * 1000
const pad = (n: number) => String(n).padStart(2, '0')

/**
 * Part of the day for an hour (0–23), as in a Latvian summer (user decision): sunrise ≈ 04:30 and
 * sunset ≈ 22:20 around midsummer, light until nearly 23:30 — so the night is short.
 */
export function dayPeriod(hour: number) {
  if (hour < 4 || hour >= 23) return 'night'
  if (hour < 12) return 'morning'
  if (hour < 18) return 'afternoon'
  return 'evening'
}

export function clockParts(ms: number) {
  const s = Math.floor(ms / 1000)
  const hour = Math.floor(s / 3600) % 24
  return {
    day: Math.floor(ms / DAY_MS) + 1,
    hm: `${pad(hour)}:${pad(Math.floor(s / 60) % 60)}`,
    ss: pad(s % 60),
    period: dayPeriod(hour),
  }
}

/** Buttons in display order: minutes to move the clock by. */
const SHIFTS: [label: string, minutes: number][] = [
  ['−12h', -720],
  ['−1h', -60],
  ['−10m', -10],
  ['−1m', -1],
  ['+1m', 1],
  ['+10m', 10],
  ['+1h', 60],
  ['+12h', 720],
]

export function GameClock(props: { session: Session; oob?: boolean }) {
  const { running } = props.session.clock
  const ms = props.session.clockMs()
  const { day, hm, ss, period } = clockParts(ms)
  return (
    <section
      id="game-clock"
      class={`card game-clock${running ? ' running' : ''}`}
      data-ms={ms}
      data-running={running ? '1' : '0'}
      hx-swap-oob={props.oob ? 'true' : undefined}
    >
      <div class="clock-readout">
        <span class="clock-day">
          Day <b data-clock="day">{day}</b>
        </span>
        <span class="clock-time">
          <span data-clock="hm">{hm}</span>
          <small data-clock="ss">{ss}</small>
        </span>
        <span class="clock-period" data-clock="period">
          {period}
        </span>
      </div>
      <div class="clock-controls">
        <button type="button" class="small clock-toggle" hx-post="/table/clock/toggle" hx-swap="none">
          {running ? '⏸ Pause' : '▶ Resume'}
        </button>
        <div class="clock-shifts">
          {SHIFTS.map(([label, minutes]) => (
            <button type="button" class="small" hx-post={`/table/clock/shift?min=${minutes}`} hx-swap="none">
              {label}
            </button>
          ))}
        </div>
      </div>
    </section>
  )
}
