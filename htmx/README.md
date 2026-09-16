# Roll Table

Digital character sheets and dice for an in-person RPG session.
The GM laptop runs the server; players open it in their phone browser over local Wi-Fi.

See [PROJECT.md](PROJECT.md) for goals, decisions, architecture and current status.

## Run

```powershell
bun install      # first time only
bun run dev      # auto-restarts when you save code
```

The terminal prints a QR code and the player URL. The GM screen is at http://localhost:3000/gm
(the same QR code is on the GM screen under "Players join at…").

Other commands: `bun test` (engine tests), `bun run check` (type check), `bun run start` (no auto-restart).

## Changing the rules

Edit `system/rules.yaml`, then restart the server. It is validated on startup;
typos in ids or formulas stop the server with a readable message.

## Layout

```
system/rules.yaml     RPG system definition (sections, fields, derived values, rolls)
src/index.ts          entry: loads rules + event log, prints URLs/QR, starts server
src/app.tsx           routes and live-update pushes
src/session.ts        event log (SQLite) + state rebuilt from it, undo
src/engine/expr.ts    formula / dice expression evaluator
src/engine/sheet.ts   derived values from character values
src/hub.ts            connected devices (WebSocket)
src/views/            HTML (Hono JSX): layout, sheet, feed, pages
public/               app.js (sound, connection), style.css
data/session.db       event log — delete it to start a fresh campaign
```

## How it works

- Every change (field edit, roll, undo) is appended to the event log; current state is rebuilt from it.
- Pages are server-rendered HTML. Buttons use htmx to POST; the server pushes updated
  HTML fragments to affected devices over a WebSocket.
- Rolls happen on the server. GM rolls can be public, secret (players see "GM rolled in secret"),
  or GM-only (players see nothing).
