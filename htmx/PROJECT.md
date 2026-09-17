# Roll Table — Project Brief

Hand-off document for anyone (human or agent) continuing this project.
It records **what is being built, why decisions were made, and what exists today**.
Read this before changing architecture — most choices below were made deliberately with the user.

Last updated: 2026-09-17 (editable stats, pool circles)

---

## 1. Goal

A GM runs an **in-person** tabletop RPG session for 4–5 friends using a **custom RPG system that is still being designed**.
Character sheets and roll resolution should be digital.

- Everyone sits at the same table. Players use **their own phones or laptops** (mix of iPhone and Android, ~50/50).
- The GM's Windows laptop runs the app; devices connect over **local Wi-Fi**. No internet or cloud needed.
- The rules change between sessions, so **rules live in a data file, not in code**.

### Scope of automation (user decision)

It is an **upgraded notation tool with automated calculations — not a rules engine**.

- Players freely edit their own sheets (wounds, gear, notes, stats). No permission system.
- The app computes derived values and dice results, but **does not apply consequences** (no auto-damage, no enforced costs).
- The GM keeps rulings in their head; the app provides a change log so edits can be checked.

### Out of scope (for now)

- Between-session progression (XP, leveling, editing sheets at home).
- Remote play, accounts, authentication, cloud hosting.
- Haptics, shake-to-roll, native mobile apps.

---

## 2. Decisions log

| Topic | Decision | Reason |
|---|---|---|
| Platform | **Web app in the browser**, no install | 50/50 iOS/Android; iOS sideloading is painful; rules change often and web updates instantly |
| Frontend approach | **htmx** (+ Alpine.js for tiny client state) | User has no JS framework experience; app is mostly server-owned data view/edit; no build step |
| Server | **Bun + Hono** (TypeScript) | Lightest local setup: WebSocket, SQLite, TS, hot reload all built into Bun |
| Hosting | **GM laptop on local Wi-Fi**, plain HTTP | No internet, no cost. Consequence: no HTTPS → no Wake Lock / PWA / motion sensors |
| Where rolls happen | **On the server** | Originally "on each device" (players are trusted). Changed when htmx was chosen: server-rendered fits htmx, and secret GM rolls stay secret without special handling |
| State model | **Event log** (append-only), state rebuilt from events | Gives change log, undo, and roll feed for free |
| Live updates | **WebSocket** pushing htmx out-of-band HTML fragments | Instant, two-way standard |
| Rules loading | **Loaded once at startup**, validated | Simple; restart after editing rules |
| Roll visibility | public / GM-only / secret ("GM rolled in secret") | Secret GM rolls were requested |
| Physical dice | Wanted, secondary — **not built yet** | Primarily digital rolls |
| Sessions | One database = one campaign; GM "Start new session" inserts a marker event | Feed and change log only show the current play session; history stays in the log |
| Character management | GM can rename and delete (soft delete via event); no player-side rename | Clean up test/duplicate characters without wiping the database |
| Character stages | **Draft** (in creation) → **Finish character** (player alone) → **active** | Creation choices aren't worth logging; later traits will modify many values at once |
| Draft storage | Separate `drafts` table, overwritten per edit, not in the event log | Survives phone sleep/reload and is visible live to the GM, without log noise |
| Base values | Sections/fields with `base: true`; frozen at finish. Play changes stored as **adjustment** (current = base + adj) | Players see normal vs current value; base corrections keep in-play modifiers |
| Editing base | Anyone, via "✎ Base" mode on an active sheet; logged as `base_set`, undoable | User wanted it open to all; a distinct mode avoids accidental base edits |
| Creation rules | Fully flexible for now (free steppers within min..max) | Trait picking system planned later (see §8) |
| Keep phones awake | **Not built** (deliberately) | Locking is normal and saves battery; instead the page reliably catches up on unlock (see §6). Opt-in NoSleep-style toggle is a possible later addition |
| Sound | Wanted. Synthesised via Web Audio for now | No asset files to manage yet |
| Godot | Not used for this app | Too clunky for dynamic data-driven screens; the Godot project stays as the reference for the rolling system |

---

## 3. Repository context

```
roll-roll/
  src/roll-roll/        Godot project (GDScript) — earlier prototype. Contains the REAL rolling
                        system (special die rolls, exertion, skill distribution, difficulty…).
                        Treat as reference material; it is not part of the web app.
  htmx/                 ← this web app
```

`rules.yaml` holds the user's real bio fields, abilities, skills and derived values, but no rolls. The real rolling mechanics have **not** been
ported from Godot yet; the user asked not to design the rolling system in the web app until then.

---

## 4. Architecture

```
GM laptop (Bun process)
┌──────────────────────────────────────────────────────────────────────┐
│ system/rules.yaml ─▶ rules.ts (load + validate, dry-run formulas)    │
│                                                                      │
│ HTTP routes (app.tsx) ─▶ Session (session.ts)                        │
│   htmx POSTs               append event → SQLite data/session.db     │
│                            apply to in-memory state (rebuild on undo)│
│                                   │                                  │
│                        engine/expr.ts   engine/sheet.ts              │
│                        dice & formulas  derived values               │
│                                   │                                  │
│ views/*.tsx (Hono JSX) ─▶ HTML fragments ─▶ hub.ts ─▶ WebSockets     │
└──────────────────────────────────────────────────────────────────────┘
        │ full pages over HTTP, live fragments over WS
   Player phones (/play)          GM laptop screen (/gm)
```

Request flow for any change:
1. Button/field has `hx-post` → server route.
2. Route calls a `Session` method → event appended to SQLite + applied in memory.
3. Route pushes re-rendered fragments via `hub.send(filter, render)` to affected clients.
4. Route returns `204` (htmx does nothing with the response). Errors for free-text rolls return a text body swapped into a `.error` element.

---

## 5. File map

```
htmx/
  PROJECT.md            this document
  README.md             short run instructions
  package.json          scripts: dev (hot), start, check (tsc), test via `bun test`
  tsconfig.json         strict, noUncheckedIndexedAccess, skipLibCheck (TS 7 vs bun-types), Hono JSX
  system/icons/         ability icons (SVG, stroke=currentColor) referenced from rules.yaml
  system/rules.yaml     RPG system definition (user's real bio/abilities/skills/derived; rolls still empty)
  data/session.db       SQLite event log (gitignored). Delete to start fresh.
  public/
    app.js              sound synthesis, mute store (Alpine), feed trimming, connection handling
    style.css           dark, mobile-first styling
  src/
    index.ts            entry: chdir to project, load rules, open session, print QR + URLs, export Bun server config
    app.tsx             Hono routes, static files, push helpers
    rules.ts            YAML loading + validation → typed Rules
    session.ts          event types, SQLite persistence (events + drafts), state projection, stages/base values, undo, roll
    session.test.ts     bun tests for drafts, finishing, base/adjustment, undo, restart replay
    rules.test.ts       bun tests for field icon/colour parsing and validation
    hub.ts              connected WebSocket clients, send helper, heartbeat
    network.ts          LAN IPv4 detection (prefers Wi-Fi, skips virtual adapters)
    engine/
      expr.ts           tokenizer + recursive-descent evaluator for formulas and dice
      expr.test.ts      bun tests for the evaluator
      sheet.ts          default values, computeScope (fields + derived)
    views/
      layout.tsx        page shell: scripts, ws-connect, top bar (connection dot, mute)
      sheet.tsx         Sheet, SheetHead, FieldView, DerivedView (generated from rules), GM Manage section
      feed.tsx          RollEntry (per-viewer visibility), Feed, SessionMarker, ChangeLog
      pages.tsx         JoinPage, PlayerPage, GmPage, SessionLabel, WhoLink, CharacterRemoved
```

Dependencies: `hono`, `htmx.org@2`, `htmx-ext-ws@2`, `alpinejs@3`, `qrcode`; dev: `typescript@7`, `@types/bun`, `@types/qrcode`.
Vendor JS is served from `node_modules` at `/vendor/*` so phones never need internet.

---

## 6. How the pieces work

### 6.1 Rules file (`system/rules.yaml`)

```yaml
name: Sample System
sections:
  - label: Attributes
    fields:
      - { id: body, label: Body, type: number, min: 1, max: 5, default: 2 }
  - label: Condition
    fields:
      - { id: wounds, label: Wounds, type: track, max: 5 }
  - label: Gear & Notes
    fields:
      - { id: gear, label: Gear, type: text, lines: 4 }
derived:
  - { id: wound_penalty, label: Wound penalty, formula: "floor(wounds / 2)" }
rolls:
  - { id: athletics_check, label: Athletics, dice: "(body + athletics - wound_penalty)d6" }
```

- Field types: `number` (stepper, clamped min..max), `track` (pips 0..max), `text` (textarea).
- Optional look on any field: `icon` = file in `system/icons/` (SVG inlined at startup after stripping XML prolog/comments, drawn with `currentColor` → white on the colour chip; PNG/WebP/JPG linked via `/system/icons/*`) or short text/emoji; `color` = hex (quoted; unquoted numbers are padded). Missing files / bad colours fail startup. Rendered by `FieldName` (icon chip) and `rowAttrs` (`--field-color` custom property → left stripe) in `views/sheet.tsx`.
- Word scales: top-level `scales: { rating: { 1: horrible, 2: low, 3: average, 4: high, 5: excellent } }`; a section or number field with `scale: rating` shows the **word + one dot per point** (dots in the field colour) instead of the number — in the closed row, inside the open stepper, and in the "base …" note. Values without a word (e.g. 0 or a buffed 6) fall back to the number, dots capped at 10. Unknown scale names fail startup. Core and Supporting Abilities use `rating` (1 horrible … 5 excellent); Skills use `skill` (0 untrained, 1 novice, 2 experienced, 3 advanced, 4 expert, 5 master — at 0 the closed row shows no word or dots; the open stepper still says "untrained").
- Abilities and skills have user-chosen colours (skills grouped: combat #af6d77, manipulation/performance #ddac88, acrobatics/athletics/stealth #cfccca, rest #f2d08d). The 27 icons in `system/icons/` were drawn for this project as placeholders (stroke line icons, 24×24) — replace freely.
- Icon ink: `rules.ts` computes WCAG luminance of `color`; > 0.45 → dark icon (`#1b1a1f`), otherwise white. Exposed as `--field-ink` next to `--field-color`.
- Ids must be unique across fields/derived/rolls, match `[A-Za-z_][A-Za-z0-9_]*`, and must not look like dice (`d6`).
- **Calculated stats** (`type: derived` + `formula`) can sit inside any section and support `icon`/`color`; they render as `DerivedRow` (class `field stat`). In creation they are read-only (`readonly` class keeps values aligned). Once finished they get the same ✎ toggle: play changes are stored as `statAdj[stat]` (current = formula + adj, ≥ 0), logged as `stat_set` and undoable. `pool: true` (Health, Mind, Stamina, Willpower) treats the formula as a **maximum**: circles, filled = left, empty = spent, current clamped to 0..max; damage persists when the max changes. Regular stats show a number with ▲/▼ when modified; open rows show "normal N · reset" / "X of N · restore". Formulas and rolls use the **formula results**, not play-adjusted stats. They are not in `rules.fields` (not editable/stored). Top-level `derived:` entries (`inSection: false`) still render in the compact `.derived` block (currently none).
- Derived formulas are evaluated in order — section ones top to bottom, then the top-level list; they may reference fields and earlier derived values; dice not allowed.
- Current sheet order (user-specified): Bio, Core Abilities, Supporting Abilities, **Body** (Health, Mind), **Reserves** (Stamina, Willpower), **Defense** (Evasion, Physical resistance, Mental resistance), **Misc** (Speed), Skills, Gear & Notes. Stat colours are all `#ffffff` placeholders for the user to customise. "Body" stat was renamed to **Health** (id `health`). The user's list said "Reserves: Stamina, Resolve"; kept label **Willpower** (Resolve is already a supporting ability) — pending confirmation.
- On startup every formula and roll is dry-run against defaults; any problem aborts startup with a list of errors.
- Events referencing fields later removed from the rules are ignored when rebuilding state.

### 6.2 Expression language (`engine/expr.ts`)

- Numbers, names (from scope), `+ - * /`, parentheses, unary minus.
- Functions: `floor ceil round abs min max`.
- Dice: `NdS`, `dS`, `(expr)dS`. Count is floored and clamped at ≥0; max 100 dice, sides 1..1000.
- RNG: `crypto.getRandomValues` with rejection sampling. Injectable `rng` for tests.
- Returns `{ total, breakdown, dice }`; breakdown looks like `3d6[6,2,4] + 1` or `1d20[19] + body:3`.
- Errors throw `ExprError` (shown to the user for free-text rolls).

This is a **generic placeholder**. The real system (from Godot) will likely need richer roll
results (success counting, special dice, exertion interaction, player choices mid-roll). Expect
`RollEvent` and the roll UI to change when porting.

### 6.3 Event log (`session.ts`)

SQLite table `events(id, ts, type, data JSON)`. Event types:

| type | data |
|---|---|
| `character_created` | `charId, name` |
| `character_renamed` | `charId, from, to, by` |
| `character_deleted` | `charId, by` (removed from play; events stay in the log) |
| `session_started` | `by` |
| `character_finalized` | `charId, base {field: n}, values (full snapshot), by` |
| `field_set` | `charId, field, from, to, by` (by = character name or `GM`). For base fields of active characters from/to are **current** values; applying sets `adj = to − base` |
| `base_set` | `charId, field, from, to, by` (base value, clamped to field min..max) |
| `stat_set` | `charId, stat, adj, from, to, by` — play change to a calculated stat (adj applied; from/to shown values) |
| `roll` | `charId \| null (GM), by, label, expr, total, breakdown, visibility` |
| `undo` | `target` (event id), `by` |

- On startup all events are loaded and state is rebuilt.
- New events are applied incrementally; an `undo` triggers a full rebuild that skips undone events.
- `undoLast(charId)` undoes the most recent non-undone `field_set` for that character. No redo. Rolls are not undoable.
- Clamping/validation happens in `setField`; no-op changes produce no event.
- **Character stages**: `Character.status` is `draft` until `character_finalized`. Draft edits go to the `drafts` table (`char_id, data JSON, updated`) via `saveDraft` and are layered over replayed state at the end of `rebuild()` (so legacy `field_set` events of old drafts still count). Finalizing deletes the draft row.
- **Values**: always read through `session.valueOf(char, field)` (current) and `session.baseOf(char, field)`. Active base field current = `max(0, base + adj)`; play range is 0..PLAY_MAX (99), base range is the field's min..max. `scope()` feeds current values to formulas.
- `undoLast` undoes the latest `field_set` **or** `base_set`.
- `session.names` keeps the latest name of every character ever created (incl. deleted) for the change log.
- `recentRolls()` / `recentChanges()` only return events since the last `session_started`. `sessionNumber()` counts those markers.

### 6.4 Identity and pages

- `/` → `/play`. If the `char` cookie points to an existing character → player sheet; otherwise the join page (pick existing or create new).
- `/leave` clears the cookie (switch character).
- Cookie is per origin (IP:port). If the laptop's IP changes, players rescan the QR and pick their character from the list.
- Posting a deleted `charId` from a stale join page just redirects back to the join page (no character is created).
- `/gm` — GM screen: join QR code, session card ("Session N" + Start new session), GM roll form with visibility, roll feed, change log, all sheets (editable, each with a "Manage" section for rename/delete).
- **No authentication.** Players are trusted; anyone on the Wi-Fi can open `/gm`.
- Actor name for the change log: GM page sends header `X-Actor: gm` (set via `hx-headers` on `<body>`); otherwise the cookie's character name.

### 6.5 Routes

| Method | Path | Body | Effect |
|---|---|---|---|
| GET | `/play` | | join page or player page |
| POST | `/join` | `charId` or `name` | set cookie, create character if new (pushes new sheet to GM), 303 → `/play` |
| GET | `/leave` | | clear cookie |
| GET | `/gm` | | GM page |
| POST | `/c/:id/set` | `field, value` | set field (tracks, text) |
| POST | `/c/:id/adjust` | `field, delta` | increment number field (avoids races on fast taps) |
| POST | `/c/:id/undo` | | undo last change, pushes whole sheet |
| POST | `/c/:id/finalize` | | draft → active (hx-confirm); pushes whole sheet |
| POST | `/c/:id/adjust-base` | `field, delta` | active only: change base value (logged) |
| POST | `/c/:id/adjust-stat` | `stat, delta` | active only: play change to a calculated stat (pools: spend/restore) |
| POST | `/c/:id/set-stat` | `stat, value` | active only: set stat's shown value (reset/restore links) |
| POST | `/c/:id/rename` | `name` | GM: rename; pushes sheet head (+ player's top-bar link) |
| POST | `/c/:id/delete` | | GM (hx-confirm): delete; GM sheet removed, player's `#main` replaced with "character removed" |
| POST | `/gm/session` | | GM (hx-confirm): start new session; every feed reset to the session marker |
| GET | `/health` | | 204; clients check it before reloading |
| POST | `/c/:id/roll` | `roll` (roll id) | public roll from rules |
| POST | `/c/:id/roll-free` | `expr` | public free roll; returns error text or empty |
| POST | `/gm/roll` | `expr, label, visibility` | GM roll; returns error text or empty |
| GET | `/ws?char=ID` / `/ws?gm=1` | | WebSocket |
| GET | `/vendor/*`, `/public/*` | | static files |

### 6.6 Live updates (WebSocket protocol)

Server → client messages are **HTML** handled by the htmx `ws` extension (`hx-ext="ws" ws-connect=...` on `<body>`).
Every top-level element is an out-of-band swap:

- New roll: `<div hx-swap-oob="afterbegin:#feed">…entry…</div>` rendered **per client** by role:
  players never receive `gm` rolls; `hidden` rolls render as "GM rolled in secret".
- Field change: `<… id="f-{charId}-{fieldId}" hx-swap-oob="true">` + every stat row `<div id="dv-{charId}-{derivedId}" hx-swap-oob="true">` + `<dl id="derived-{charId}">` if top-level derived exist (`DerivedUpdates`); GM also gets `<ul id="changes" hx-swap-oob="true">`.
- Undo: whole `<section id="sheet-{charId}" hx-swap-oob="true">` (+ change log for GM). GM version includes the Manage section, player version doesn't — render per role.
- Rename: `<div id="head-{charId}" hx-swap-oob="true">`; player also gets `<a id="who-link">`; GM gets change log.
- Delete: GM gets `<section id="sheet-{charId}" hx-swap-oob="delete">`; player gets `<main id="main" hx-swap-oob="true">` (removed notice).
- New session: `<div hx-swap-oob="innerHTML:#feed">{session marker}</div>` to all (innerHTML, not outerHTML, so the feed's MutationObserver survives); GM also gets `#session-label` and change log.
- New character: `<div hx-swap-oob="beforeend:#sheets">` to GM only.
- Field/sheet updates go only to that character's player sockets and GM sockets (avoids oob "target not found" errors elsewhere).
- **Heartbeat**: a single space `' '` every 15 s to all clients (no swap happens, but the client records it).

Client → server: nothing over WS; all actions are normal htmx HTTP POSTs.

Notes:
- Hono's Bun adapter creates a new `WSContext` per event, so clients are matched by `ws.raw`.
- Client set and heartbeat timer live on `globalThis` so `bun --hot` reloads don't duplicate them.

### 6.6b Sheet UI stages (`views/sheet.tsx`)

- Draft: "In creation" badge, hint strip, plain steppers, no Undo/rolls, "Finish character" button at the bottom.
- Number rows (draft and active) show only the **value** and a per-row **edit toggle** (✎ ↔ ✓). Steppers are hidden until the row is open (user request: no always-visible − / +). Open rows are tracked in the section's Alpine state `open.<fieldId>` and the row binds `x-bind:class="{ editing: open.<id> }"`, so a row stays open when a live update replaces it.
- Field name and value use the field's colour (`--field-color`). Number rows use `flex-wrap`, so an open row moves its controls to a second line on phones (rated steppers are wide).
- Active base fields (`BaseField`): the base value is **not** shown by default (user request). While the row is open, "base N" (+ "reset" when modified) appears under the name; when closed, a modified value gets a small ▲/▼ marker (title shows base).
- Base fields have two steppers: `.play` (posts `/adjust`) and `.base-edit` (posts `/adjust-base`).
- "✎ Base" toggle is Alpine state on the `<section>` (`x-data="{ editBase: false }"`, class `editing-base`); CSS shows base steppers directly on base rows (hiding value, marker and edit toggle) and a sticky purple "Editing base values" banner. Field oob swaps don't reset the mode (the section isn't replaced); whole-sheet pushes (undo, finalize) do.

### 6.7 Client script (`public/app.js`)

- **Sound**: Web Audio synthesis (`roll` = clicks like tumbling dice, `secret` = low tone). Audio unlocks on first `pointerdown` (iOS requirement). A `MutationObserver` on `#feed` plays `data-sound` of newly added entries. Mute stored per device in `localStorage` (wrapped in try/catch), exposed as Alpine store `$store.sound`.
- **Feed** is trimmed to 60 entries client-side.
- **Connection handling** (so sleeping phones never show stale data):
  - Every reload goes through `reloadWhenServerUp()`: polls `GET /health` every 3 s and only reloads once it answers, so a phone never reloads into the browser's "can't connect" page (where no script could recover). While waiting, `body.offline` shows a "Reconnecting to the GM laptop…" banner.
  - `htmx:wsClose` → mark disconnected + show banner; the htmx ws extension retries (codes 1006/1011/1012/1013); next `htmx:wsOpen` → reload.
  - `htmx:wsAfterMessage` updates `lastMessageAt`.
  - On `visibilitychange` (unlock/tab return): if no message for 40 s → reload (forced).
  - Every 10 s while visible: same check, but skipped while the user is typing (focused textarea or non-empty input).
  - `pageshow` with `persisted` (back/forward cache) → reload.
  - `window.rollTable` exposes `checkConnection` and `lastMessageAt` for debugging.

---

## 7. Status

### Done and verified (browser tests on 2026-09-16, desktop + 375 px mobile viewport)

- Join / create character, cookie identity, switch character.
- Sheet generated from rules: steppers, pips, text, derived values recalculating live.
- Rolls from rules and free-text rolls; error display for bad expressions.
- GM roll visibility: public, GM-only (invisible to players), secret (players see placeholder).
- Live sync player ↔ GM; change log; undo with strike-through in log.
- Heartbeat received; stale-connection reload on visibility change; typing guard; no reload when fresh.
- Server down: phone shows banner and waits (no reload into error page); server back → phone reloads by itself.
- Restart persistence: characters, session number, deletions survive a server restart.
- Start new session clears player + GM feeds and change log live.
- GM rename updates player sheet head and top bar live; GM delete removes the GM sheet and shows the removed notice on the player; deleted characters disappear from the join list.
- `bun test` (evaluator + session stage tests in `src/session.test.ts`) and `bun run check` pass.
- Creation stage: draft edits not logged, GM sees draft live with badge, finish logs one event, rolls appear after finishing.
- Play: current vs base display, modified highlight + reset, base edit mode (banner, stepper swap, stays on during live updates), base change keeps adjustment, undo of base changes, change log entries. Checked at 375 px.

### Not verified yet

- Real phones on the real Wi-Fi (iOS Safari socket behaviour after lock, audio unlock, layout).
- Several simultaneous players.
- Long sessions / large event logs (rebuild is O(events), expected fine for hundreds–thousands).

### Known limitations

- Placeholder rules and generic dice engine — real system not ported.
- No physical-dice entry.
- No auth on `/gm`.
- Screens may sleep (by design, see decisions).
- A whole-sheet push after undo can replace a textarea someone is editing on the same sheet.
- Text field changes save on `change` (blur), not while typing.
- No redo; rolls, renames, deletions, session starts and finishing a character cannot be undone (no "reopen creation" yet).
- Characters created before the stage feature have no `character_finalized` event, so they show as drafts (their previous values are kept); finish them once.
- Undo of in-play value changes is by event order per character; undoing an adjustment after a later base change restores the old *current* value relative to the base at that time.
- Rename doesn't update the browser tab `<title>` until reload; past rolls keep the old name (stored at roll time).
- Client feed trimming (60 entries) can drop the session marker in very long sessions.
- No UI to switch between campaigns; use separate DB files via the `DB` env var.
- Recommended: DHCP reservation for the GM laptop so the URL and phone cookies stay valid between sessions.
- `bun build --compile` single exe not set up (static paths point into `node_modules`).

---

## 8. Next steps (suggested order)

1. **Trait picking in creation** (user-confirmed, later): store *choices* (trait ids, point allocations) in the draft and compute values from them; `rules.yaml` gets trait groups with modifiers and budgets; finish blocked until valid. Keep finalization producing plain base values so play logic stays unchanged. Consider a GM "reopen creation" using stored choices.
2. **Port the rolling system** from the Godot project (`../src/roll-roll`). Read its scripts first;
   the user said it has real complexity (special die rolls, exertion, skill distribution, difficulty).
   Likely changes: richer `RollDef` in rules.yaml, a roll result model beyond `total/breakdown`,
   possibly multi-step rolls (player choices) with server-held pending-roll state, updated `RollEntry` view.
   Keep the engine UI-free and cover it with `bun test`.
3. **Physical dice entry**: same roll button, "I rolled physically" toggle → input dice faces → same math, feed marks it as physical.
4. Test on real phones at the table; fix what shows up.
5. Optional: situational ± modifier before rolling, GM rolling on behalf of a player (hidden result), opt-in keep-awake toggle, real sound files, table display page (`/table`) showing only the feed.

---

## 9. Running and working on it

```powershell
cd C:\projects\roll-roll\htmx
bun install
bun run dev        # http://localhost:3000/gm ; players use the printed LAN URL / QR
bun test
bun run check
```

Env vars: `PORT` (default 3000), `DB` (SQLite path, default `data/session.db`) — useful for testing
without touching real session data, e.g. `PORT=3999 DB=/tmp/test.db bun run src/index.ts`.

### Gotchas

- **Bun PATH**: installed at `%USERPROFILE%\.bun\bin`. Shells opened before installation won't find `bun`.
- **Windows networking**: Wi-Fi profile must be *Private* and Bun allowed through the firewall on private networks, or phones can't connect. Some routers block device-to-device traffic; a phone hotspot works around it.
- **Rules changes need a restart** (`bun --hot` reloads code, but rules are read once at startup — hot reload does re-run startup, so it usually works; restart if in doubt).
- **Typecheck**: TypeScript 7 conflicts with some `bun-types` declarations, hence `skipLibCheck`.
- **htmx attributes in JSX**: use `hx-on--after-request` (dash form), `hx-vals={JSON.stringify(...)}`; pass `undefined` (not `false`) to omit attributes.
- **Browser-pane testing**: the embedded test browser may report `document.visibilityState === 'hidden'`; override it when testing visibility logic.
- **Style**: 2-space indent, no semicolons, single quotes, small focused modules, comments only where intent isn't obvious.
