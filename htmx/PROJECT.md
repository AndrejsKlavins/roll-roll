# Roll Table — Project Brief

Hand-off document for anyone (human or agent) continuing this project.
It records **what is being built, why decisions were made, and what exists today**.
Read this before changing architecture — most choices below were made deliberately with the user.

Last updated: 2026-09-22 (Opposition roll: head-to-head, two checks, core decides)

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

- XP tracking and editing sheets at home. (Levelling = the sheet's "Level up" button, which grants skill points.)
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
| Skills | **Trained with skill points**, not set directly. Rank from points assigned: rank n costs 3+n more (4, 5, 6, 7, 8 → totals 4/9/15/22/30), capped at master | User-designed progression |
| Skill points | Pool = granted − assigned. Granted on finishing and per **level up** (= Max skill points = 3 + Knowledge + Intuition + Resolve, **base values only**); GM can give/take any amount (Manage section, GM-only). **Level up** is a button on the sheet next to the **Level** counter (Bio, after Race) — anyone can press it (confirm dialog), and Undo reverts a level up | User request |
| Training | Any time after creation via a **Train** toggle on Skills; + spends (blocked at 0 available), − takes back (for corrections); logged and undoable. Skills can't be trained or set during creation | User decision |
| Skill ✎ | Temporary bonus on top of the trained rank; "✎ Base" mode doesn't touch skills | User decision |
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
- **Skill training** (`rules.ts` `Training`, top-level `training: { points_stat, rank_costs }`; section/field `trained: true` implies `base`): `baseOf` of a trained field = `rankOf(skillPoints[id])` (thresholds = cumulative rank_costs). Character keeps `skillPoints`, `pointsGranted`, `level`. `availablePoints = granted − Σ assigned` (may go negative via GM correction, shown red). `pointsPerLevel` = the points stat evaluated with `scope(id, { base: true })`. Derived `base: true` (`useBase`) = evaluated on base values and read-only. Draft: trained fields read-only at rank 0 with a note. UI: `TrainBar` (available + Train toggle, Alpine `training` on the section) and `TrainPanel` under each trained row (5 rank rows of 4–8 circles, then − and + side by side at the right; no points text); `LevelRow` (`type: level` item in a section, one per sheet, `rules.level`): level number + Level up button (active only). GM `ManagePoints` info line + Give points in Manage. Train panel order: − / + (left-aligned) on top, then the rank rows. Every training/grant pushes all trained rows (their + depends on the pool), the bar, stats and GM info.
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
| `skill_points_granted` | `charId, amount, reason ('creation' \| 'level' \| 'gm'), by` — level ups increment `level` |
| `skill_trained` | `charId, skill, from, to, by` — points assigned to a trained field (undoable). Every point is stored, but `Session.worthLogging` keeps it out of the change log unless the **rank** changed (and hides undos of hidden ones); the log names ranks, not points |
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
| POST | `/c/:id/train` | `skill, delta` | active only: assign (+1, needs available points) / take back (−1) a skill point |
| POST | `/c/:id/level-up` | | anyone (sheet button): level + 1 and one level's worth of skill points (undoable) |
| POST | `/c/:id/grant-points` | `amount` | GM: give (or take, if negative) skill points |
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

### 6.6c Challenge setup (`views/challenge.tsx`)

Challenges themselves (board, rolling, outcomes, the `/table` screen) came from a separate
session and are only summarised here; this covers the **GM setup flow**, which the user redesigned.

- The GM board shows **only** a "Start new challenge" button; it opens `<dialog id="challenge-dialog">`
  (`ChallengeSetupDialog`), rendered by `GmPage` **outside** `ChallengeBoard` so board pushes
  (a player rolling) can't close it mid-edit.
- The dialog opens with a required **description** ("What is the challenge?"): Start stays disabled
  until it has text, `startChallenge` refuses a blank one, and it heads the board on every screen
  (larger on `/table`) and names each entry in the challenge history.
- Inside the dialog everything is Alpine state on the form (`stakes`, `mainAbility`/`mainDiff`/`mainValue`,
  the same for support, `charId`), mirrored into hidden inputs with `x-model` and posted to
  `/gm/challenge/start`. Stakes are three buttons with **Normal** (the middle one) preselected.
- Each side is a `SidePicker`: a big indicator (ability name, then that ability's icon + the difficulty
  number in the ability's colour, with the tier name in brackets — every icon is rendered and `x-show`
  picks one, so no SVG is needed client-side) above two columns — abilities (icon + coloured name) and difficulty tiers. Selection is
  `x-bind:class="{ on: … }"`; Start stays disabled until both sides and a player are picked.
- **Players no longer join**: the GM picks who rolls in the dialog, and the start route calls
  `setChallengePlayer`. The player's own board only shows approach/skill/roll once they are on it.
  `ChallengePlayerPicker` (`#challenge-players`) is swapped on its own (`pushChallengePlayers`, e.g.
  when a character is finished) so the list stays current without closing an open dialog.
- After a successful start the form clears its picks via `Alpine.$data(this)` and closes the dialog.

**Circumstance modifier** (user-designed): once the difficulties are set, the GM may nudge either
side's target with a **− / + stepper** under it (`CircumstanceControls`, GM board only, hidden once
the challenge is closed). Each press moves that side by one, clamped to `MAX_CIRCUMSTANCE` (±5, so
one press covers the usual ruling and a rough situation can go further); the button disables at the
end of the range.

**The modifier is added to the difficulty** (user decision, after seeing it the other way round
first): a `+2` on a difficulty of 10 is a target of 12 and works *against* the player, while `−1` on
a difficulty of 7 is a target of 6 and helps them. `challengeTarget(ch, side)` is the only place that
arithmetic lives — `challengeOutcome` and all three screens go through it, so a modifier can't be
applied twice or missed. Because the outcome follows it, so does everything
derived from the outcome: the difference, the degrees, and whether a `failure` approach
(Unbreakable) is still in effect.

It is **visible to everyone** (user requirement): the target shows the adjusted number with a signed
chip beside it — **red for a plus** (it raised the difficulty), green for a minus — titled with the
arithmetic ("Circumstance +2 — difficulty 10 raised to 12"), on the GM board, the player's page and
`/table`. Only
the GM gets the stepper. The **tier name stays that of the GM's original difficulty** ("8 (Hard)"),
since the tier is the GM's assessment of the task and the chip is what circumstances did to it; the
challenge history shows the effective targets and flags "· circumstance" so those numbers aren't
mistaken for the raw ones.

Layout note: the GM column is a fixed **360px** holding both difficulty boxes side by side, so
anything added inside a box has to stay narrow. `.challenge-numbers` uses `repeat(2, minmax(0, 1fr))`
rather than `1fr 1fr` (a plain `1fr` will not shrink below its content's min-content width, so a wide
child overflows the column instead of compressing — this cost 79px of clipping when the stepper's
legend sat inline), `.difficulty-target` wraps, and the stepper stacks its legend above the buttons.

State is `mainCircumstance`/`supportCircumstance` on the challenge, written by
`challenge_circumstance_set` via `adjustCircumstance(challengeId, side, delta, by)`
(`/gm/challenge/circumstance?side=…&delta=±1`). The event stores the **whole new modifier, not the
step**, so a replay lands on the same number however many times it was nudged, and a step that would
change nothing (a 0, or pushing past the clamp) is refused rather than logged. Settable from the
moment the challenge is started — before the dice are in or part-way through — until "Challenge
done". Not undoable, like the rest of a challenge.

**Approach die** (user-designed): the player picks an approach before rolling (Unbreakable /
Exquisite / Limitless) from **one stacked button per approach, each with its `description` from
rules.yaml to the left** (user-specified layout; `ChallengeSetupControls`). A pick posts straight to
`/c/:id/challenge/setup` and the board comes back with that button marked `on` — no radios, no form,
and the Skill boost select posts on `change` by itself. An approach with no `description` falls back
to a hint made from `when`. `rollChallenge` then rolls **one plain d6** alongside the ability dice —
no rank shift, stored as `approachDie` on `challenge_rolled` (absent when no approach is picked, and on
challenges rolled before this existed). Two things are configured per approach in
`challenges.approaches`:

**Nothing ever applies on its own** (user decision): the player always presses **Activate result**.

`when` — whether that button is offered at all:

| `when` | approach | status shown |
|---|---|---|
| `always` | Limitless | always `active` |
| `failure` | Unbreakable | `active` while the roll fails (at least one side short of its target), `skipped` once it succeeds — derived, so it flips live as skill points/exertion move the sums. **Once activated the status locks to `active`**, so an effect that turns the roll into a success (raising dice, say) doesn't grey out the thing that caused it |
| `choice` | Exquisite | `ready` until the player activates it, then `active` |

`effects` — what each **face** does, and therefore what the player is asked to tap after Activate.
All user-designed:

| kind | after Activate | used by |
|---|---|---|
| `none` | nothing — no Activate button at all | Limitless 2, Unbreakable 1, Exquisite 1 |
| `declare` | a ruling with no dice to change; Activate just records it ("In effect") | Unbreakable 2 (Unshakable) |
| `discard` | tap a die; it stays on screen struck through and drops out of the sum | Limitless 1 |
| `reroll` | tap a die; it is rolled again, **free of exertion** | Limitless 3 |
| `extra_dice` | pick one of the two abilities; `dice` more dice are rolled at that ability's rank and join the side | Limitless 4/5 (1), 6 (2) |
| `raise_face` | tap `dice` dice; each moves one face up. A die already on the **top face stays put** and the pick is still spent (user decision), so it gets no marker | Unbreakable 3/4 (2 dice) |
| `set_face` | tap `dice` dice; each is set to `to_face`, **up or down** (user decision — a good die may be lowered) | Unbreakable 5/6 (2 dice → face 3) |
| `lower_raise` | **two steps**: tap a die to lower it one face, then *another* to raise it one face | Exquisite 2 (Tweak) |
| `match_highest` | pick one ability; its **lowest** die rises to the face of its **highest** (one pick, of an ability) | Exquisite 3/4 (Perfect balance) |
| `discard_double` | **two steps**: tap a die on one ability to discard it, then a die on the **other** ability to copy it (the twin joins that side and counts) | Exquisite 5/6 (Perfect choice) |

Any **cost is settled at the table** — the app never deducts one (user decision); the rules.yaml
labels say so and nothing is spent automatically.

**Two-step effects** (Exquisite, user-designed): the first three kinds above ask for N *identical*
taps, which `dice` counts. The last three don't — they are fixed-shape effects whose picks do
**different things**, so they ignore `dice` and `effectPicks` returns what they actually need (2, 1
and 2). Which pick is outstanding comes from `effectStep(effect, picksLeft)` → `'first' | 'second'`,
surfaced on `approachState` as `step` (with `firstPickSide`, the side the first pick landed on) so
the board and the session agree on one answer:

| face | effect | first pick | second pick |
|---|---|---|---|
| Exquisite 2 | Tweak (`lower_raise`) | tap a die → one face **down**, marker `lowered` | tap another → one face **up**, marker `raised` |
| Exquisite 3/4 | Perfect balance (`match_highest`) | pick an **ability** → its lowest in-play die rises to its highest face, marker `matched` | — |
| Exquisite 5/6 | Perfect choice (`discard_double`) | tap a die → discarded (as `discard`) | tap a die on the **other** ability → a twin joins that side, marker `copied` |

Decisions inside those: Tweak **only offers a die that has somewhere to go** (user decision) — one
already on the **worst** face cannot be lowered and one on the **best** face cannot be raised, since
that tap would spend the pick and move nothing. It is per step, not a blanket ban: a die on the worst
face is still a legal *raise* target. `session.tweakableDie(ch, side, index)` is the single rule, and
the board asks it before making a die a button, so refused dice are simply not tappable;
`anyTweakableDie(ch)` backs a status line for the (rare) case where no die qualifies, rather than
prompting for a tap nothing can satisfy. Tweak-only — `raise_face` (Unbreakable) keeps its earlier
decision of spending the pick on a top-face die. The one-pick-per-die rule still means the raise
cannot undo the die just lowered. Perfect balance reads "choose your *lowest* skill result",
but the app **lets the player pick either ability** — it is a notation tool, not a rules engine, and
the GM keeps the ruling; a side whose dice already match spends the pick with nothing moved, and one
with nothing in play can't be picked. Perfect choice **doubles by copying** (user decision): the twin
carries the tapped die's face *and* its rank-shifted value, and it must be on the other ability — a
tap on the discarded side is refused, and so is a copy taken before the discard.

`DieMarker` therefore has five values (`raised`, `lowered`, `squashed`, `matched`, `copied`), named
under the die by `markerLabel`; `lowered` reads in red and `copied` in purple, since neither is a
plain bonus. Copies ride on `challenge_dice_added`, which grew an optional `markers[]` (what to show
under each added die) and `from` (the index copied, so the pick is spent on that die rather than on
an ability — `extra_dice` still has no `from`). Old events replay unchanged. The pick route
`/c/:id/challenge/approach-pick` dispatches on `effect=`: `discard | reroll | face | copy | match`,
or no `effect` at all for extra dice.

One consequence of Exquisite finally having effects: its **blank face 1 no longer offers Activate**.
Before, an approach with no `effects` fell back to `when === 'choice'` for the button, so every
Exquisite face had one; now it behaves like Unbreakable 1 and Limitless 2 and reads "Nothing happens".

A label containing a comma must be **quoted** in rules.yaml — unquoted inside `{ }` flow it ends at
the comma, silently truncating (the Exquisite labels hit this; the older ones have no commas).

Flow and state: **Activate** (`challenge_approach_activated`) sets `approachActivated` and
`approachPicksLeft` = however many picks the effect wants (`effectPicks`). While picks are left the
board waits: dice become tap targets (`/c/:id/challenge/approach-pick?effect=discard|reroll|face&side=…&index=…`)
or the two abilities appear in the approach box, and each resolving event
(`challenge_die_discarded`, `challenge_face_changed`, `challenge_dice_added`, or `challenge_rerolled`
with `source: 'approach'`, which costs no exertion) spends one pick. **The same die is never tapped
twice for one effect** (user decision): `approachPicked` holds `"side:index"` keys and those dice stop
being buttons. The prompt counts down ("Tap 2 dice…" → "Tap a die…"). A pending effect owns the dice,
so exertion rerolls stand down until it is resolved. "Challenge done" ends the pick too — the status
line then reads "Not used".

Because of `discard`, `extra_dice` and the face-moving effects, `ChallengeSide` is no longer a fixed
pair: `dice`/`faces` are plain arrays with optional parallel `discarded` flags, `rerolled` counts and
`changed` markers ('raised' / 'squashed', shown under the die), and **`sideSum()` is the only way to
total a side** (every die that is not discarded). A face change keeps that die's own rank shift
(`dice[i] − faces[i]`), so the new value stays in step with how it was rolled. Old two-die events
replay unchanged.

`session.approachState(ch)` returns `{ approach, die, status, effect, canActivate, pending, picksLeft }`
(null when nothing was rolled) and is the single place all of this is decided; `ApproachDie` in
`views/challenge.tsx` renders it under the two result boxes on every screen — face label on one line,
what it is waiting for (or "Done" / "In effect" / "Not used") on the next — with the buttons only for
the rolling player while the challenge is open. The GM and `/table` see the same prompt in the third
person ("Player taps 2 dice to raise them one face"). Unknown `when`/`kind` values, a bad `dice` count,
a `set_face` whose `to_face` is not a configured face, and a face listed twice all fail startup. Not
undoable, like the rest of a challenge.

**Debug: set face** (GM screen only): a dashed row under the approach die with one button per
face of the d6, so a face's effect can be tried without rolling for it. It posts
`/gm/challenge/approach-die?face=N` → `session.setApproachDie` → `challenge_approach_die_set`, which
sets `approachDie` and **re-arms Activate** (`approachActivated`, `approachPicksLeft` and
`approachPicked` all reset), as if the die had just landed on that face. The current face is marked
`on`; each button's tooltip names that face's effect. Only while the challenge is **rolled, has an
approach and is not closed**, and only for faces 1–`APPROACH_DIE_SIDES` (6, the same constant
`rollChallenge` rolls). Two things it deliberately does *not* do: changes an earlier activation
already made to the ability dice (a discard, a reroll, a moved face) **stay** — they are rolled
results, and both events stay in the log — and it does not bypass `when`, so a `failure` approach on
a roll that is now succeeding still shows `skipped` with no Activate button (raise the difficulties
to test those faces). Players never see the row. Not undoable, like the rest of a challenge.

**Opposition roll** (user-designed): a head-to-head contest with **no difficulty number at all** —
the two sides are compared with each other. **Player vs player, player vs NPC or NPC vs NPC.** Its
own **"Start opposition roll"** button opens `<dialog id="opposition-dialog">` (`OppositionDialog`),
where each side is either a character with **two of its abilities** or an NPC with **two flat ranks**
(held to the same `abilityRankRange` ladder as a solo roll). NPC ranks and names are the GM's; a
character's ranks are read off the sheet **when it rolls**, so a wound taken between setup and roll
counts.

**Two checks per contestant** (user decision): a **core** ability and a **supporting** one, giving
two head-to-head comparisons. **The core check decides** — when the two disagree it is the core one
that names the winner. A level core check falls through to the supporting one rather than throwing
that away, and only a contest level on both is a **tie**, which the app reports without naming a
winner for the GM to rule on. It is **always high stakes** (no picker), so the deciding check's
margin reads as **degrees of victory** — one per full 3 points, via `outcomeFor` like every other
degree. The board says it in a line: "Mara wins by 1 degree", or "… (the core check was level)" when
the support check had to decide.

**Commit → Ready → Roll**, in three phases (`oppositionPhase`):

| phase | what happens |
|---|---|
| `committing` | each player commits **before the dice**: pool points (stamina/willpower, +1 each) and a declared skill's rank, both split across the two checks. An NPC commits nothing. |
| `rolling` | both sides have pressed **Ready**, which reveals the commitments and opens **Roll**; each side rolls its own two checks. |
| `done` | both rolled. **Nothing can be changed** (user decision): no rerolls, no late exertion, no circumstance — every control disappears and the session refuses the routes. |

**Commitments are hidden until both sides are ready** (user decision) — that is what makes Ready
worth pressing. `oppositionCommitVisible(opp, side, role, viewerCharId)` decides it per viewer: a
player always sees their own, the GM sees everything (refereeing, not competing), and the other
contestant *and the shared screen* see only "Bonus committed — hidden until both are ready" until
the reveal. Ready can be taken back only while the other side is still committing; once both are
ready the commitments are out, so there is no going back from that.

Exertion here is spent **before** the dice, unlike a challenge's (which is spent on a visible
result), and `opposition_exerted` decrements the pool on the sheet the same way `challenge_exerted`
does. The GM may Ready and Roll **either** side — an NPC has nobody else to do it, and the app has no
permission system anyway.

State lives in `oppositions` (`Opposition` with an `a` and a `b` `Contestant`); events are
`opposition_started`, `opposition_exerted`, `opposition_skill_set`, `opposition_skill_points_set`,
`opposition_ready_set` and `opposition_rolled`. `OppositionBoard` (`#opposition-board`) is its own
swap target mounted on all three screens, so a contest never disturbs the challenge board or the
solo board. Not undoable, like the rest.

**Solo roll** (user-designed): the GM's own roll, for an NPC's attempt or a hidden check — no
character, no approach, no exertion and **nobody joins it**. Its own **"Start solo roll"** button
opens `<dialog id="solo-dialog">` (`SoloRollDialog`, rendered by `GmPage` outside the boards so live
updates can't close it mid-edit), where the GM:

1. picks an **opposition number** off the same difficulty ladder, then nudges it by 1s with a
   − / + stepper (the circumstance stepper's markup, reused). The tier **names** the number while it
   still matches ("10 (Hard)") and goes unnamed as soon as a nudge moves it off, which is exactly
   what `rollSolo` records in `tier`;
2. picks the **rank to roll at** from a ladder of words — `abilityRankRange(rules)` in rules.ts,
   taken from the **word scale the sheet's abilities use** (rating: 0 abysmal … 6 epic), *not* their
   min/max, since abilities deliberately have no fixed bounds in play and those come back infinite.
   A rank off that ladder is refused, so the range stays a rules-file decision;
3. chooses **who sees it — GM only by default**, or public;
4. presses **Roll**.

One `solo_rolled` event carries the whole thing (it is set up in Alpine state and rolled in one go):
description, opposition number, tier name, rank, the rolled `ChallengeSide` and visibility. The dice
are `rollChallengeSide(rank)` — the same two dice shifted by (rank − 3) an ability side gets, so a
solo roll reads like any other. `soloOutcome()` judges it at **`low` stakes**, so it is pass/fail and
by how much, never a boon or a complication (solo rolls have no stakes picker).

`SoloRollBoard` (`#solo-board`) is its own swap target mounted on **all three screens**, so a solo
roll never disturbs the challenge board and a challenge in progress is untouched. It renders an
empty section for anyone who should not see the roll, which also clears a roll that has just been
hidden again. The GM always sees the card and gets a **"Show the table" / "Hide again"** button
(`solo_visibility_set`), so a roll made in private can be revealed after the fact — and taken back.
Not undoable, like challenges.

**Exertion** (user-designed): while a rolled challenge is open, the rolling player may burn one point
of any pool stat listed in `challenges.exertion_sources` (rules.yaml: stamina, willpower) for one
exertion — `challenge_exerted` both decrements the pool (`statAdj`, like `stat_set`) and adds to
`exertionGained`, so the sheet and board move together. Exertion is spent either as **+1 on a side**
(`challenge_exertion_spent` → `exertionMain`/`exertionSupport`, folded into `challengeOutcome`) or to
**reroll one die** (`challenge_rerolled` → new face + rank-shifted value, side sum recomputed).
Any die on the side may be rerolled, **including ones an approach effect added** (`extra_dice`,
`discard_double`), which sit at index 2 and up; only a discarded die is refused, since it no longer
counts. Both paths share `dieInPlay()`, so a side is never assumed to be a fixed pair.
`availableExertion = gained − main − support − rerolls`. Exert buttons carry each stat's icon/colour
and disable at 0; dice become reroll buttons only while exertion is in hand (a faint purple ring marks
them, since phones have no hover). Repeatable while pools last. Every reroll — exertion or approach —
is counted per die in `ChallengeSide.rerolled[i]` and shown under that die as **"Reroll N"**, so the
table can see a 1 that was bought three times.
**Challenge done** (GM only, `challenge_closed`) accepts the result: `closed` hides every player
control and shows a "Done" badge. None of these are undoable.
- Result boxes: "Player attempt" heads the rolled part on the GM and `/table` screens (the player
  sees their own controls there instead). Each die is a square tile showing the **shifted value**
  (what counts in the check) with the **face id's** name underneath, from `challenges.faces` in
  rules.yaml (1 horrible … 6 amazing, red → green; tile and name take that colour). `ChallengeSide`
  keeps both: `faces` = raw d6 ids 1–6, `dice` = the same faces shifted by (rank − 3). So a strong
  character's "horrible" (3 at rank 5) can beat a weak character's "good". `faces` is optional —
  challenges rolled before it was recorded simply show no names. The attempt's sum shows bare (no "=", no "vs target") in the ability's colour, sized
  like the target above it.
- The player's board hides the joined character's ability line (they know their own values) and
  instead splits the **skill bonus** with − / + under each result: `SkillBonusControls` posts the two
  new totals to `/c/:id/challenge/skill-points`, − is disabled at 0 for that side, + at 0 left, and
  `setChallengeSkillPoints` also caps the pair at the skill's rank (it used to allow rank on each side).
  "<Skill> bonus: N left of R" sits under the boxes.
- The board's `DifficultyBox` (GM, player and `/table`) mirrors that look: ability icon next to the
  name, target number in the ability's colour, tier name in brackets. Challenges store only the
  number, so the tier is found by matching `challenges.difficulties` on value (no match → no brackets).

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

0. Existing test characters predate skill training; the user said old characters can simply be deleted (no migration).
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
