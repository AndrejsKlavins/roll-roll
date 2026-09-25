# Roll Table — Project Brief

Hand-off document for anyone (human or agent) continuing this project.
It records **what is being built, why decisions were made, and what exists today**.
Read this before changing architecture — most choices below were made deliberately with the user.

Last updated: 2026-09-25 (Complete group / opposition challenge buttons; players see only open rolls)

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
    backup.ts           character ⇄ CSV (export, and checked import); CSV parser
    enemies.ts          enemy templates + encounter instances (Bestiary state, validation, events)
    combat.ts           hit tiers, wounds, glancing drop, defences (pure combat arithmetic)
    bestiary-routes.tsx the GM's Bestiary screen routes (/gm/bestiary, /gm/enemy/:id/…)
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
      bestiary.tsx      BestiaryPage: encounter cards + template table and dialogs, attack forms
      combat.tsx        EncounterBoard (table), attack log lines, enemy attack breakdown
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
- **Values**: always read through `session.valueOf(char, field)` (current) and `session.baseOf(char, field)`. Active base field current = `base + adj + itemBonus` (clamped), where `adj` is the play change only and `itemBonus` is enabled equipment (see Equipment); play range is 0..PLAY_MAX (99), base range is the field's min..max. `scope()` feeds current values to formulas.
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
- **Equipment** (user-designed): a `type: equipment` row in a section (one per sheet; rules.yaml
  puts it in Gear & Notes between **Money** and the free-text Gear field) shows the character's
  items. **Add equipment** opens an Alpine form: a name, then any number of "what it modifies / by
  how much" rows, saved in one POST (`/c/:id/items/add`, modifiers as JSON). A modifier can target
  an **ability or skill** (base number field), a **calculated stat** (not base-only ones), or an
  **item-only stat** from top-level `equipment.item_stats` (Attack damage, Attack accuracy) —
  those are shown **only on the item** and feed nothing. Each item shows its name and modifier
  chips, a **Disable / Enable** toggle (a disabled item stays listed, greyed, and gives nothing) and
  **Discard** (confirm; the item and its bonuses are gone). Events `item_added` / `item_removed` /
  `item_enabled_set` carry the item's name, are in the change log and are **undoable** (`undoLast`)
  like traits. **The GM gives an item** by using the same list on the GM's copy of the sheet — same
  routes; the change log reads "GM gave Mara Lucky charm (+1 Athletics)". Finished characters only
  (a draft shows a note). Limits: a name 1–60 characters, 1–12 modifiers, whole non-zero changes up
  to ±99.
  - **How bonuses apply**: `session.itemBonus(char, target)` sums enabled items. It is added in
    `valueOf` (so formulas and challenge/opposition ranks see it), in `statOf`'s `normal` (a pool's
    maximum rises), and to the **skill bonus** in challenges and oppositions (rank + items; a
    temporary ✎ change still stays out). It is **never stored in `adj`**: `field_set` subtracts it,
    and the row's "modified" / "reset" compare against `base + gear`, so a stepper press or reset
    can't swallow or cancel an item. Rows an item touches show a small "+1 gear" note.
  - Pushes: `pushItems` sends the list, the touched rows, all stats and the challenge board.
- **Backups** (user request; GM screen, **Backups** card, and **Export character (CSV)** in each
  finished character's Manage section):
  - **Character → CSV** (`backup.ts` `characterToCsv`, `GET /gm/character/:id/export`): one row per
    value, columns `kind, id, label, value` — name, level, skill points granted, each ability's
    `base`, `skill_points` per skill, `value` for bio/money/gear/notes, `play` / `stat_play` /
    `stat_bonus` changes, `trait`s, `item` / `item_disabled` ("Strength +1; Attack damage +3"), and
    **`current` rows for reading only** (what the sheet shows; ignored on import). UTF-8 with a BOM
    so Excel opens it cleanly; a `#` comment line on top.
  - **CSV → character** (`csvToSnapshot` + `Session.importCharacter`, `POST /gm/character/import`):
    always a **new** character (fresh id) via one `character_imported` event carrying the whole
    `CharacterSnapshot`; in the change log ("GM imported Mara from a backup"). Checked against the
    **current** rules: unknown fields, traits or item targets are **left out with warnings** (shown
    under the form) rather than failing; no name or a non-backup file is refused. Hand edits in a
    spreadsheet come through; `;`-separated files and Excel's BOM are read too.
  - **Session log** (`Session.exportLog` / `importLog`, `GET /gm/log/export`, `POST /gm/log/import`):
    the whole event log as **JSON Lines** (one event per line, `id` and `ts` kept) — i.e. the entire
    game. Import **replaces** the log (confirm dialog): every line must be an event with an
    increasing whole-number id, or nothing changes. The replaced log is first written to
    `data/backup-<time>.jsonl`, so an import can be undone by importing that file. Afterwards
    `hub.closeAll()` drops every socket with code **1012** (the htmx ws extension only reconnects on
    1006/1012/1013), and each screen reloads onto the restored game. `rebuild()` now also resets the
    power level target, since it is replayed from the log. Drafts (not in the log) are untouched.
- **Money**: a plain number field with `input: true` — a typed-in box (saved on change, no − / +),
  held to its `min: 0`. Any number field that isn't a base field may use `input: true`.
- **Compact sections** (user request, for Bio): a section with `compact: true` in rules.yaml shows,
  **on the player's own sheet only**, as one row — its values in order, joined with " · " (text as
  written, empty ones left out, the level as "Level N", numbers as "Label value"; each titled with
  its label) — plus **✎ Edit**, which opens the usual fields (Level up included) and turns into
  **Done**. Alpine state `editing` on the fieldset; it starts **open while the character is in
  creation**, since that is when Bio gets filled in. The GM's sheets always show the section in
  full. `CompactSummary` has its own id (`compact-<charId>-<sectionIndex>`), and the player-side
  pushes for field, stat, trait and training changes append `compactSummaries()` so the row follows
  edits and level-ups live.
- "✎ Base" toggle is Alpine state on the `<section>` (`x-data="{ editBase: false }"`, class `editing-base`); CSS shows base steppers directly on base rows (hiding value, marker and edit toggle) and a sticky purple "Editing base values" banner. Field oob swaps don't reset the mode (the section isn't replaced); whole-sheet pushes (undo, finalize) do.

### 6.6c Challenges (`views/challenge.tsx`)

**The standard challenge** (user-redesigned): the GM sets **one difficulty for the whole
challenge** and names the **resolution** ability that decides it. They may also name a **framing**
ability that colours how it goes — **framing is optional** (user decision): skip it and the
resolution check is the whole challenge. There is no difficulty per side.

1. The GM starts it: an **optional** name (a quick challenge at the table needs none), a stakes
   pick, one difficulty off the `challenges.difficulties` ladder, the resolution ability, an
   optional framing ability, and who rolls.
2. The player picks an **approach** and, optionally, a **skill**.
3. One press rolls **both checks at the same time** (user decision) and shows them together.
4. The framing roll's margin picks a rung of the framing ladder, which moves the resolution's
   target and may add a complication. That is **worked out live**, so exertion or a reroll on the
   framing after the dice are down moves the resolution's target with it.
5. The GM presses **Challenge done**.

`session.challengePhase(ch)` names where it is: `setup` → `rolled` → `done`.

**The skill is a bonus on the rolled results, not a cut in the difficulty** (user decision, after
seeing it the other way round first): the declared skill's rank is added to **each** result, shown
as a chip beside that roll's dice and named once under the difficulty ("Athletics +2 on every
result"). The difficulty itself moves only for the GM's circumstance.

**The framing ladder** (rules.yaml, `challenges.framing`): a list of rungs by threshold, since the
bands are deliberately uneven — the −1/−2 rung is narrower than the even 0/+1/+2 one above it.
`from` is the **lowest margin a rung covers** and it runs up to the next rung's `from`; the bottom
rung also catches everything below it.

| margin | `from` | what it does |
|---|---|---|
| −9 or worse | −9 | resolution difficulty **+6** and a complication |
| −8 … −6 | −8 | resolution difficulty **+3** and a complication |
| −5 … −3 | −5 | resolution difficulty **+1** and a complication |
| −2, −1 | −2 | resolution difficulty **+1** |
| 0 … +2 | 0 | nothing changes |
| +3 … +5 | 3 | resolution difficulty **−1** |
| +6 … +8 | 6 | resolution difficulty **−3** |
| +9 or better | 9 | resolution difficulty **−6** |

A rung carries only `difficulty` and `degrees`, both **arithmetic on purpose**: the two rolls land
together and the rung is recomputed on every render, so nothing dice-shaped (extra dice, a
discarded die) could follow a framing that changes after the fact. Startup refuses two rungs
starting at the same margin.

**Stakes still scale the resolution's own degrees** and the rung's complication is **added** to
them (user decision): a −1 rung on a normal-stakes failure by 4 reads as 2 complications.

**`session.challengeMath(ch)` is the only place the arithmetic lives** — difficulty, circumstance,
skill, both targets, both outcomes, the rung and the combined degrees. Every screen, the approach
die's `failure` rule and the history log go through it, so a modifier can never be applied twice or
missed. It is **derived, never stored**, which is exactly what makes the framing recalculate live.
It works at any phase: before the roll it is just the target, and `success` stays null until the
dice are in.

**Circumstance** is a single modifier on the one difficulty (`/gm/challenge/circumstance?delta=±1`,
clamped to ±`MAX_CIRCUMSTANCE`). It is **added** to the difficulty — a plus works against the
player — settable from the moment the challenge starts until it is closed, and visible to everyone
in the calculation line. Only the GM gets the stepper. The event stores the **whole new modifier,
not the step**, so a replay lands on the same number however many times it was nudged.

**Exertion** names the roll it goes on, since both are on the table at once: a point put on the
framing re-reads the ladder and moves the resolution's target, and either roll's dice can be
rerolled. `availableExertion` is one pool across both.

**What is fixed when**: everything declared before the dice — the player, the approach and the
skill — is locked once they land, because the approach die rolls with them and the skill rides on
results that are already showing.

**Events**: `challenge_started` (one `difficulty`, a nullable `framingAbility`,
`resolutionAbility`), `challenge_player_set`, `challenge_rolled` (both sides and the approach die
in one event; `framing` absent when there is none), `challenge_circumstance_set` (no side),
`challenge_exertion_reroll_armed`,
`challenge_exertion_spent` / `challenge_rerolled` / `challenge_die_discarded` /
`challenge_face_changed` / `challenge_dice_added` (all carry `roll: 'framing' | 'resolution'`),
and `challenge_closed`. Gone: the old per-side `challenge_rolled`, `challenge_skill_points_set`
(the skill is no longer split between sides) and the short-lived
`challenge_framing_rolled`/`challenge_resolution_rolled` pair. **Challenges logged before the
redesign are dropped on replay** (user decision: no migration); their `challenge_started` has no
`resolutionAbility`, the reducer skips it, and their later events then find no challenge.

#### The GM setup dialog

- **GM column order** (user decision): Players join · Session · Backups · Power level · the two
  screen links (outlined: Public table screen, Bestiary & encounter) · **the roll starters, one
  style** (`GmActions` in pages.tsx: Start new challenge / opposition roll / group task / solo
  roll / magic roll — each opens its dialog; the boards no longer carry their own start buttons) ·
  GM roll · Roll boon / complication · **Add to the table log** (a line of the GM's own text:
  `addLogNote` → `log_note_added`, `session.logNotes`, shown italic in the table's history log
  in time order; not removable yet) · then the current boards, the feed and the change log.
- "Start new challenge" opens `<dialog id="challenge-dialog">`
  (`ChallengeSetupDialog`), rendered by `GmPage` **outside** `ChallengeBoard` so board pushes
  (a player rolling) can't close it mid-edit.
- Everything is Alpine state on the form (`description`, `stakes`, `diff`/`diffValue`,
  `framingAbility`, `resolutionAbility`, `charId`), mirrored into hidden inputs with `x-model` and
  posted to `/gm/challenge/start`. Stakes are three buttons with **Normal** preselected.
- One `DifficultyPicker` (the tier ladder) and two `AbilityPicker`s, each a big indicator of what is
  picked above a wrapping list of the sheet's abilities — every icon is rendered and `x-show` picks
  one, so no SVG is needed client-side. The framing one is `skippable`: it leads with a **"No
  framing — resolution only"** button that clears the pick, and its indicator then reads "No framing
  roll". Start stays disabled until the difficulty, the **resolution** ability and a player are
  picked; the framing ability and the name are both optional.
- **Players no longer join**: the GM picks who rolls in the dialog, and the start route calls
  `setChallengePlayer`. `ChallengePlayerPicker` (`#challenge-players`) is swapped on its own
  (`pushChallengePlayers`, e.g. when a character is finished) so the list stays current without
  closing an open dialog.
- After a successful start the form clears its picks via `Alpine.$data(this)` and closes the dialog.

Layout note: the GM column is a fixed **360px** holding the two roll boxes side by side, so anything
added inside a box has to stay narrow. `.challenge-numbers` uses `repeat(2, minmax(0, 1fr))` rather
than `1fr 1fr` (a plain `1fr` will not shrink below its content's min-content width, so a wide child
overflows the column instead of compressing — this cost 79px of clipping when the circumstance
stepper's legend sat inline), `.difficulty-target` wraps, and the stepper stacks its legend above
the buttons. With framing skipped the pair becomes `.challenge-numbers.solo`, one centred column, so
the single box doesn't stretch across both. The one difficulty sits in its own `.difficulty-panel`
above them.

**Approach die** (user-designed): the player picks an approach before rolling (Unbreakable /
Exquisite / Limitless) from **one stacked button per approach, each with its `description` from
rules.yaml to the left** (user-specified layout; `ChallengeSetupControls`). A pick posts straight to
`/c/:id/challenge/setup` and the board comes back with that button marked `on` — no radios, no form,
and the Skill select posts on `change` by itself. An approach with no `description` falls back
to a hint made from `when`. The approach die acts on **both rolls** (user decision — it used to
act on the resolution roll alone): `rollChallenge` rolls **one plain d6** alongside the framing and
resolution dice — no rank shift, stored as `approachDie` on
`challenge_rolled` (absent when no approach is picked). Two things are configured per
approach in `challenges.approaches`:

**Nothing ever applies on its own** (user decision): the player always presses **Activate result**.

`when` — whether that button is offered at all:

| `when` | approach | status shown |
|---|---|---|
| `always` | Limitless | always `active` |
| `failure` | Unbreakable | `active` if **at least one** roll — the framing (when there is one) or the resolution — was short of its target **the instant the dice landed**, else `skipped` (user decision). It is a snapshot, `Challenge.failingAtRoll`, taken in the `challenge_rolled` reducer: exertion, a reroll or a circumstance nudge that later turns the failure into a success **does not** take Unbreakable away. **Once activated the status locks to `active`** too |
| `choice` | Exquisite | `ready` until the player activates it, then `active` |

`effects` — what each **face** does, and therefore what the player is asked to tap after Activate.
All user-designed. Everything here acts on **both rolls**: a tapped die may sit on either the
framing or the resolution roll (a multi-pick effect may split its taps between them).
`match_highest` has nothing to tap and applies to **each roll** — framing only when there is one —
the moment Activate is pressed. `extra_dice` goes onto **one** roll, which **the player picks**
(user decision). (`when: failure` looks at both rolls too — see below.)

| kind | after Activate | used by |
|---|---|---|
| `none` | nothing — no Activate button at all | Limitless 2, Unbreakable 1, Exquisite 1 |
| `declare` | a ruling with no dice to change; Activate just records it ("In effect") | Unbreakable 2 (Unshakable) |
| `discard` | tap a die; it stays on screen struck through and drops out of the sum | Limitless 1 |
| `reroll` | tap a die; it is rolled again, **free of exertion** | Limitless 3 |
| `extra_dice` | **pick a roll** (one button per roll under the approach die): `dice` more dice join it, rolled at that roll's ability rank. With framing skipped there is no choice, so they go straight onto the resolution on Activate | Limitless 4/5 (1), 6 (2) |
| `raise_face` | tap `dice` dice; each moves one face up. A die already on the **top face stays put** and the pick is still spent (user decision), so it gets no marker | Unbreakable 3/4 (2 dice) |
| `set_face` | tap `dice` dice; each is set to `to_face`, **up or down** (user decision — a good die may be lowered) | Unbreakable 5/6 (2 dice → face 3) |
| `lower_face` | tap **one** die (either roll); it moves one face **down**, marker `lowered`. Only a die that can go lower is offered (`tweakableDie`), and with **every die on its worst face there is no Activate button** — the status reads "Can't be used — every die is at its worst face" (user decision). What Setup buys — **"Improved"** on the next roll that uses the lowered die's ability, letting the player set any die to max — is **handled at the table, not by the app** (user decision); the label says so | Exquisite 4/5 (Setup) |
| `lower_raise` | **two steps**: tap a die to lower it one face, then *another* to raise it one face | Exquisite 2/3 (Tweak) |
| `match_highest` | **nothing to tap**: on each roll, its **lowest** die rises to the face of its own **highest** | none right now (was Exquisite 4, Perfect balance); the kind still works |
| `max_face` | tap **one** die (either roll); it goes straight to the **top** face, keeping its rank shift, marker `maxed` ("Max"). Only a die below the top face is offered, and with **every die already at the top there is no Activate button** ("Can't be used — every die is already at its top face") — the same rule as Setup, the other way up | Exquisite 6 (Perfect choice) |
| `discard_double` | **two steps**: tap a die to discard it, then *another* to copy (the twin joins the roll and counts) | none right now (was Exquisite 5/6, the old Perfect choice); the kind still works |

Any **cost is settled at the table** — the app never deducts one (user decision); the rules.yaml
labels say so and nothing is spent automatically.

**Two-step effects** (Exquisite, user-designed): `Tweak` and `Perfect choice` are fixed-shape
effects whose two picks do **different things**, so they ignore `dice` and `effectPicks` returns 2.
Which pick is outstanding comes from `effectStep(effect, picksLeft)` → `'first' | 'second'`,
surfaced on `approachState` as `step` so the board and the session agree on one answer:

| face | effect | first pick | second pick |
|---|---|---|---|
| Exquisite 2/3 | Tweak (`lower_raise`) | tap a die → one face **down**, marker `lowered` | tap another → one face **up**, marker `raised` |
| (unused) | `discard_double` | tap a die → discarded (as `discard`) | tap another → a twin joins the roll, marker `copied` |

Decisions inside those: Tweak **only offers a die that has somewhere to go** (user decision) — one
already on the **worst** face cannot be lowered and one on the **best** face cannot be raised, since
that tap would spend the pick and move nothing. It is per step, not a blanket ban: a die on the worst
face is still a legal *raise* target. `session.tweakableDie(ch, index)` is the single rule, and
the board asks it before making a die a button, so refused dice are simply not tappable;
`anyTweakableDie(ch)` backs a status line for the (rare) case where no die qualifies, rather than
prompting for a tap nothing can satisfy. Tweak-only — `raise_face` (Unbreakable) keeps its earlier
decision of spending the pick on a top-face die. With framing skipped only the resolution **pair**
is on the board, so Tweak can run out of legal targets more often there. The
one-pick-per-die rule still means the raise cannot undo the die just lowered. Perfect balance moves
nothing when the dice already match. Perfect choice **doubles by copying** (user decision): the twin
carries the tapped die's face *and* its rank-shifted value and joins **that die's own roll**, and
the one-pick-per-die rule keeps it off the die just discarded.

`DieMarker` has `raised`, `lowered`, `squashed`, `matched`, `copied`, `maxed` (Perfect choice) and
`set` (the hand-edit Set die), named
under the die by `markerLabel`; `lowered` reads in red and `copied` in purple, since neither is a
plain bonus. Copies ride on `challenge_dice_added`, which carries an optional `markers[]` (what to
show under each added die) and `from` (the index copied, so the pick is spent on that die —
`extra_dice` has no `from`; its one pick is the choice of roll, which the event clears). The pick
route `/c/:id/challenge/approach-pick` dispatches on `effect=`: `discard | reroll | face | copy |
dice` (`dice` = extra dice onto `roll`, via `session.addApproachDice`).

One consequence of Exquisite finally having effects: its **blank face 1 no longer offers Activate**.
Before, an approach with no `effects` fell back to `when === 'choice'` for the button, so every
Exquisite face had one; now it behaves like Unbreakable 1 and Limitless 2 and reads "Nothing happens".

A label containing a comma must be **quoted** in rules.yaml — unquoted inside `{ }` flow it ends at
the comma, silently truncating (the Exquisite labels hit this; the older ones have no commas).

Flow and state: **Activate** (`challenge_approach_activated`) sets `approachActivated` and
`approachPicksLeft` = however many picks the effect wants (`effectPicks`; 1 for `extra_dice`, or 0
when framing was skipped), then applies the kinds that need no pick (`match_highest`, and
`extra_dice` with no framing) there and then. While picks are left the
board waits: the dice of both rolls become tap targets
(`/c/:id/challenge/approach-pick?effect=discard|reroll|face|copy&roll=framing|resolution&index=…`),
and each resolving event
(`challenge_die_discarded`, `challenge_face_changed`, `challenge_dice_added`, or `challenge_rerolled`
with `source: 'approach'`, which costs no exertion) spends one pick. `spendApproachPick` is a no-op
when nothing is outstanding, so the effects that apply on Activate pass through it without spending
one. **The same die is never tapped twice for one effect** (user decision): `approachPicked` holds
`"roll:index"` keys and those dice stop being buttons. The prompt counts down ("Tap 2 dice…" →
"Tap a die…"). A pending effect owns the dice, so exertion rerolls stand down until it is resolved.
"Challenge done" ends the pick too — the status line then reads "Not used".

Because of the approach effects (`extra_dice`, `discard_double`, `discard`), `ChallengeSide` is
not a fixed pair: `dice`/`faces` are plain arrays with optional parallel
`discarded` flags, `rerolled` counts and `changed` markers, and **`sideSum()` is the only way to
total a roll** (every die that is not discarded). A face change keeps that die's own rank shift
(`dice[i] − faces[i]`), so the new value stays in step with how it was rolled.

`session.approachState(ch)` returns `{ approach, die, status, effect, canActivate, pending, picksLeft, step }`
(null until the resolution is rolled, and for a challenge with no approach) and is the single place
all of this is decided; `ApproachDie` in `views/challenge.tsx` renders it under the two roll boxes on
every screen — face label on one line, what it is waiting for (or "Done" / "In effect" / "Not used")
on the next — with the buttons only for the rolling player while the challenge is open. The GM and
`/table` see the same prompt in the third person ("Player taps 2 dice to raise them one face").
Unknown `when`/`kind` values, a bad `dice` count, a `set_face` whose `to_face` is not a configured
face, and a face listed twice all fail startup. Not undoable, like the rest of a challenge.

**Debug: set face** (GM screen only): a dashed row under the approach die with one button per
face of the d6, so a face's effect can be tried without rolling for it. It posts
`/gm/challenge/approach-die?face=N` → `session.setApproachDie` → `challenge_approach_die_set`, which
sets `approachDie` and **re-arms Activate** (`approachActivated`, `approachPicksLeft` and
`approachPicked` all reset), as if the die had just landed on that face. The current face is marked
`on`; each button's tooltip names that face's effect. Only while the **resolution is rolled**, the
challenge has an approach and is not closed, and only for faces 1–`APPROACH_DIE_SIDES` (6, the same
constant `rollChallenge` rolls). Two things it deliberately does *not* do: changes an earlier
activation already made to the resolution dice (a discard, a reroll, a moved face) **stay** — they
are rolled results, and both events stay in the log — and it does not bypass `when`, so a `failure`
approach on a roll that is now succeeding still shows `skipped` with no Activate button (raise the
difficulty to test those faces). Players never see the row. Not undoable, like the rest.

**Opposition roll** (user-designed): a head-to-head contest with **no difficulty number at all** —
the two sides are compared with each other. **Player vs player, player vs NPC or NPC vs NPC.** Its
own **"Start opposition roll"** button opens `<dialog id="opposition-dialog">` (`OppositionDialog`),
where each side is either a character with **two of its abilities** or an NPC with **two flat ranks**
(held to the same `abilityRankRange` ladder as a solo roll). NPC ranks and names are the GM's; a
character's ranks are read off the sheet **when it rolls**, so a wound taken between setup and roll
counts.

**Framing and resolution, like a challenge** (user decision; they used to be "core" and
"supporting"): each contestant rolls a **framing** check and a **resolution** check.
- **Framing influences resolution the same way as in a challenge**: there is no difficulty, so each
  side's framing **margin is its framing total against the other side's** (a's is +m, b's −m). That
  margin picks a rung on the **same `challenges.framing` ladder**, and the rung's bonus goes straight
  onto that side's resolution total — shown in its breakdown as a "Framing" chip, with the rung's
  label (and any "— a complication") under the framing check, like `FramingCaption`. The rung
  depends on both framings, so it only exists once **both sides have rolled** (`oppositionOutcome`
  works it out; `oppositionSum` is a side's own total without it).
- **The resolution decides** (with the rung bonus in). A level resolution falls through to the
  framing margin rather than throwing that away, and only level on both is a **tie**, reported
  without a winner for the GM to rule on. **Always high stakes** (no picker): the deciding margin
  reads as **degrees of victory**, one per full 3 points via `outcomeFor`. The board says it in a
  line: "Mara wins by 2 degrees", or "… (the resolution was level, so the framing decided)". A
  rung's complication is shown on that side, not folded into the degrees of victory. **The
  winner's resolution shows its margin** next to its total ("= 12 +4", in green; user request) —
  only on the side that took the resolution.
- **Old logs still load**: events from before the rename carry `core` (= resolution) and `support`
  (= framing) — `contestantFromLog` and the reducer read both spellings (tested).

**Commit → Ready → Roll**, in three phases (`oppositionPhase`):

| phase | what happens |
|---|---|
| `committing` | each player commits **before the dice**: pool points (stamina/willpower, +1 each, on the check they pick) and a declared skill, whose **rank counts in full on both checks** (user decision, as in a challenge — it used to be split by hand; old `opposition_skill_points_set` events are ignored on replay). An NPC commits nothing. |
| `rolling` | both sides have pressed **Ready**, which reveals the commitments and opens **Roll**; each side rolls its own two checks. |
| `done` | both rolled. **Nothing can be changed** (user decision): no rerolls, no late exertion, no circumstance — every control disappears and the session refuses the routes. |

**"Complete opposition challenge"** (GM button, `/gm/opposition/done` → `closeOpposition` →
`opposition_closed`, sets `Opposition.closed`): ends the contest at any phase. A closed contest is
frozen (Ready, skill, exertion and Roll are refused), shows a "Done" badge to the GM and the table,
and **disappears from the players' screens**. Closed before both rolled, its status reads
"Completed by the GM before both sides rolled".

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
`opposition_ready_set`, `opposition_rolled` and `opposition_closed`. `OppositionBoard` (`#opposition-board`) is its own
swap target mounted on all three screens, so a contest never disturbs the challenge board or the
solo board. Not undoable, like the rest.

**Layout** (user decision): `/table` (and the GM) get **`OppGrid`, a 2 × 2 grid** — one column per
contestant, names on top, **framing in the first row and resolution in the second**, so the two
checks being compared sit side by side; Ready / Roll go underneath. A **player sees only their own
side** (`OppOwnSide`: name, framing, resolution, their controls) — never the other contestant's
checks; the status line above still names who is being waited on and who won. Both layouts are
built from the same `OppName` / `OppCheckCell` / `OppFooter` pieces. A finished contest also goes
into the **table's history log** once the next one starts ("Mara vs Guard: stare down — Guard wins
by a hair", accent border), ordered by its `seq` like everything else there.

**Who sees which roll** (user decision): the **GM** sees every current roll (but **not the history
log** — they read it on `/table`). **`/table`** sees every public
roll — the current challenge and the challenge history log, the current opposition, and a solo roll
once it is `public`. A **player** sees only rolls they are part of, and only the current one **while it is still
open** (user decision: once the GM completes a challenge, group task or opposition it leaves their
screen): the current challenge when `ch.charId` is theirs **or they are one of its supporters**, the
current group task when they take part, the current opposition when their character is one of
its sides, and **never** a solo roll (no player is in one) nor the challenge history. The filtering
is in the three boards themselves (`ChallengeBoard`, `OppositionBoard`, `SoloRollBoard`), which is
safe because every push renders per client (`hub.send` with the client's role and `charId`); each
board always renders its empty `<section>` so the next live update has somewhere to land — e.g. the
moment the GM hands a challenge to that player.

**Boons & complications** (user-designed): two GM buttons, **Roll boon** / **Roll complication**,
open one small dialog (`views/consequence.tsx`): pick a **rank** (1–3), press **Roll**, and the
result shows in the dialog — the die ("d5 rolled 3"), the entry's name and its text. The button then
reads **Reroll** and rolls again at once; changing the rank sets it back to Roll. The tables live in
rules.yaml under top-level **`consequences`** (`boons` / `complications`: one entry per face, in
order from 1, each with `ranks: [{ title, text }, …]`); **the die has one side per face** (five
faces → d5) and every face must list the same number of ranks, checked at startup. Rolled on the
server (`session.rollConsequence`, `POST /gm/consequence/roll`) like every roll, but **a private
lookup for the GM**: nothing is logged, shown to players or the table, or applied to a sheet (user
decision so far — the text is read out at the table).

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
empty section for anyone who should not see the roll — players always, `/table` while it is GM-only
— which also clears a roll that has just been hidden again. The GM always sees the card and gets a **"Show the table" / "Hide again"** button
(`solo_visibility_set`), so a roll made in private can be revealed after the fact — and taken back.
Not undoable, like challenges.

**Exertion** (user-designed): while a rolled challenge is open, the rolling player may burn one
point of any pool stat listed in `challenges.exertion_sources` (rules.yaml: stamina, willpower) for
one exertion — `challenge_exerted` both decrements the pool (`statAdj`, like `stat_set`) and adds to
`exertionGained`, so the sheet and board move together. Exertion is spent either as **+1 on one
roll** (`challenge_exertion_spent` → `exertionFraming`/`exertionResolution`, folded into
`challengeMath`) or to **reroll one of its dice** (`challenge_rerolled` → new face + rank-shifted
value, sum recomputed).

**A point in hand offers two options** (user decision), in the exertion panel under the board:
**+1** — one button per roll, "+1 to framing (Strength)" / "+1 to resolution (Agility)" — or
**Reroll a die**. The dice are **not** tappable until the player picks Reroll: that sets
`exertionRerollArmed` (`challenge_exertion_reroll_armed`, via `/c/:id/challenge/reroll-mode?armed=1`),
every die in play on both rolls becomes a reroll button, and the panel shows "Tap any die to reroll
it" with **Cancel** (`armed=0`), which hands the point back for either use. The reroll itself clears
the flag, so one point is one die. While armed, `spendExertion` is refused; `rerollDie` is refused
unless armed. Reroll can't be picked while an approach effect is waiting for taps (that effect owns
the dice), and activating one drops a reroll already chosen. The routes take
`roll=framing|resolution`. A point put on the **framing** is the interesting one — it changes that
margin, so the rung, the resolution's target and the complication all move with it, without the
resolution's own dice being touched. A challenge with no framing roll refuses exertion on one.
The pool is shared: `availableExertion = gained − framing − resolution − rerolls`.

Any die on either roll may be rerolled, **including ones an approach effect added** (`extra_dice`,
`discard_double`), which sit at index 2 and up; only a discarded die is refused, since it no longer
counts. Both paths share `dieInPlay()`, so a roll is never assumed to be a fixed pair. Exert buttons
carry each stat's icon/colour and disable at 0; dice become reroll buttons only once Reroll a die is
chosen (a faint purple ring marks them, since phones have no hover). Repeatable while pools last.
Every reroll — exertion or approach — is counted per die in `ChallengeSide.rerolled[i]` and shown
under that die as **"Reroll N"**, so the table can see a 1 that was bought three times.

**Group task** (user-designed): the GM's **"Start group task"** opens `GroupTaskDialog`: an optional
description, stakes, a difficulty off the ladder **nudged ±1 before anyone is invited** (fixed once
started — no circumstance afterwards), an optional framing and a resolution ability, and **who
joins** (any number of finished characters; the count is shown). One `group_task_started` event
creates a `GroupTask` with **one ordinary `Challenge` per participant** (`groupId` set, `charId`
fixed), so the challenge maths, skill bonus, framing rung, exertion (+1 or a reroll) and reroll
rules are the very same code. Per participant: pick a **skill**, **Roll**, then exertion as in a
challenge — but **no approach die and no supporters** (`setChallengePlayer`, `addSupporter`,
`adjustCircumstance` and `closeChallenge` refuse group members; `challengeById` finds members for
every other challenge method). `GroupTaskBoard` (`#group-board`, all three screens; a player sees it
only when they take part, and then sees everyone's rolls) shows the difficulty once, each
participant's name + result and their framing/resolution boxes, and **at the very bottom the total**:
everyone's resolution margins added up (`groupTotal`, "2 of 3 rolled"). **"Complete group
challenge"** (`group_task_closed`) closes every part at once and takes it off the players' screens. Routes: `/gm/group/start|done`,
`/c/:id/group/setup|roll|exert|spend-exertion|reroll-mode|reroll` (the participant's own part;
`ExertionControls` takes a `base` URL). **History log** (table): "Group task: Haul the cart
(challenging) 7 — Mara +3, Jorik -2 · total +1", green/red by the total's sign, once closed or
replaced by a newer one.

**Support** (user-designed): the GM adds other players as **supporters** of the current challenge
(a "Add a supporter…" list on the GM board: finished characters other than the one rolling; ✕ takes
one off again, with their die). A supporter **sees the challenge on their own screen** (they are
part of it — `ChallengeBoard`'s player filter counts supporters) and, **once the dice are in**, is
prompted to spend **1 stamina or willpower — off their own sheet, the app deducts nothing** (user
decision) — and roll **one die** of an ability they pick (at its current rank, `rollOneFace`) onto
the **framing or the resolution** (two buttons; framing only when there is one). The die is added
to that check in `challengeMath` (`supportTotal`) and shown in its breakdown as a chip named after
the supporter; on the framing it moves the rung like any framing bonus. One die per supporter;
nothing after "Challenge done". Everyone sees a "Jorik supports — +4 on framing (Perception)" line.
Events: `challenge_supporter_added` / `_removed` / `challenge_support_rolled`; making the supporter
the roller drops them from the supporters. It does not touch `failingAtRoll` (Unbreakable).

**Hand edits** (user-designed): once a challenge is rolled and until it is closed, **each roll box**
(framing and resolution) carries **−1 / +1 / Set die** in its header, for **the GM and the rolling
player** (not other players, not `/table`). Routes: `/gm/challenge/custom|set-die` and
`/c/:id/challenge/custom|set-die`, both `?roll=framing|resolution`; the session's
`editableChallenge(id, charId | null)` decides who may (null = the GM).
- **±1** → `challenge_custom_set` (stores the **whole new value**, like the circumstance) into
  `customFraming` / `customResolution`, added to that roll's sum in `challengeMath` and shown in its
  breakdown as a **"Custom"** chip. A point on the framing moves the rung like exertion does. No clamp.
- **Set die** → pick a die, then its face. The picking is **browser-side** (Alpine on the roll box:
  `setting`, `die`) so the GM and the player never see each other's half-made pick; only the chosen
  face is posted (`SetDieFaces` renders one row of face buttons per die, in the configured names and
  colours, the current face disabled). `challenge_die_set` puts the die on that face **keeping its
  own rank shift** and marks it **"Set"** (`DieMarker` `set`). Any die in play may be set, added ones
  included; discarded dice are not offered. Set die is **disabled while the dice are busy** — an
  exertion reroll the player chose, or an approach effect waiting for taps — so a tap can't do two
  things. A live update redraws the board and drops a half-made pick.

These edits are after-the-roll corrections, so they **don't** touch `failingAtRoll` (Unbreakable).

**Challenge done** (GM only, `challenge_closed`) accepts the result: `closed` hides every player
control and shows a "Done" badge. None of these are undoable.
- `DifficultyPanel` heads the board on every screen: the number in big type with the GM's tier in
  brackets. The GM's circumstance is shown as working under it (`10 + 1 circumstance = 11`, a plus
  in red and a minus in green), and the declared skill is named once below ("Athletics +2 on every
  result") since it rides on the rolls rather than on this number. The GM also gets the
  circumstance stepper here.
- `RollBox` is one of the rolls: "FRAMING" / "RESOLUTION" above the ability's icon and name, the
  number it goes against, and (once rolled) its dice, sum and difference. The resolution's number
  carries a signed chip when the framing rung moved it, titled with what did it. With framing
  skipped there is only the resolution box.
- `FramingResult` sits between the boxes: the margin, then the rung's own label from rules.yaml
  ("A big disadvantage — resolution difficulty +3 and a complication"), bordered green for a rung
  up and red for one that raises the target or costs a complication.
- The head line carries the stakes badge, Success/Failure once the dice are in, and the combined
  boons/complications (`math.degrees` — the stakes' own plus the framing rung's).
- Result boxes: "Player attempt" heads the rolled part on the GM and `/table` screens (the player
  sees their own controls there instead). Each die is a square tile showing the **shifted value**
  (what counts in the check) with the **face id's** name underneath, from `challenges.faces` in
  rules.yaml (1 horrible … 6 amazing, red → green; tile and name take that colour). `ChallengeSide`
  keeps both: `faces` = raw d6 ids 1–6, `dice` = the same faces shifted by (rank − 3). So a strong
  character's "horrible" (3 at rank 5) can beat a weak character's "good". The skill bonus and any
  exertion follow the dice as chips, then the sum shows bare (no "=", no "vs target") in the
  ability's colour, sized like the target above it.
- The player's board hides the joined character's ability line (they know their own values). The
  skill is not split between sides — it is a flat bonus on both — so `SkillBonusControls` and
  `/c/:id/challenge/skill-points` are gone.
- The history log is **on `/table` only** (user decision: the GM reads it there, so the GM screen
  doesn't repeat it). It is **one sentence per challenge** (user-specified format):
  "Mara attempts to scale the wall (challenging) 7 and succeeds with +4". The tier in brackets is
  named from the GM's own difficulty (left out when the number isn't on the ladder); the number is
  the **effective** target (difficulty + circumstance); the margin is the **resolution's**
  (`math.resolution.difference`, so framing bonus, skill and exertion are all in it), "+0" on a
  bare success. Unrolled challenges stop after the number. The row keeps its green/red left border
  for success/failure; abilities, stakes and degrees are no longer listed there.
- **Public solo rolls are in the same log** (user request): every solo roll whose visibility is
  `public` gets a line — "Guard spots the rope (easy) 4 and succeeds with +6" (the GM's description,
  or "Solo roll"; the tier, left out once a nudge moved the number off it; the opposition number;
  the margin). GM-only ones never appear; **"Show the table" adds the line and "Hide again" takes it
  back out**, so both solo routes also push the challenge board. Lines are ordered by `seq` — the
  id of the event that created the challenge or rolled the solo roll — so a roll revealed later
  keeps its place in time. Unlike challenges, the current solo roll is listed too (its card sits in
  its own board, not above the log).


### 6.6d Bestiary & encounter (`enemies.ts`, `views/bestiary.tsx`, `bestiary-routes.tsx`)

First step of the combat system (user-designed; the attack roll itself comes later). The GM's
**Bestiary** is its own screen, **`/gm/bestiary`** (user decision: the GM screen is crowded enough),
opened from the GM screen's "Bestiary & encounter ↗" link.

**An enemy** has Health and Mind (pools; **down once Health is below 0**, "broken" once Mind is),
a **to-hit roll** and a **damage roll** — each `dice` d6 at a `rank` (every rank above/below 3
shifts each die by 1, exactly like a character's ability dice; written `2d6(3)`) plus a flat
bonus — Evasion, Physical and Mental resistance, Speed, and a free-text **description** for special
abilities (read by the GM, applied by nothing).

**Templates** start from `rules.yaml`'s top-level `enemies:` list (parsed by `parseEnemyTemplates`;
rat, combat midge and wolf are the user's own numbers, the rest are suggestions — the file's
comment gives the average human for comparison). On the screen the GM can **edit** any template,
make **new** ones (`custom_…` ids, starting from the average human) and **delete** any; an edited
built-in shows "edited" and can be **reset to the rules file**. These are events
(`enemy_template_saved` / `enemy_template_deleted`) layered over the file's list in
`Bestiary.templates()`, so they survive restarts and log export/import.

**Instances**: **Spawn ×N** copies a template into the encounter (`enemies_spawned` carries the
stats as they were), named "Wolf 1", "Wolf 2"… continuing after the highest number still there.
**Every copy has its own stats** — each number on its card is an input saved on change
(`enemy_updated` with a one-field patch), so one wolf can be tweaked without touching the template
or the others, and editing a template later never reaches enemies already spawned (the card says
"tweaked" when it differs from its template, "Template deleted" when that is gone). Health and
Mind have −/+ and a typed current value, **capped at the max**, floor −99; lowering a max pulls the
current value down, raising it doesn't heal. Cards are listed **fastest first** (Speed, then spawn
order). **Remove** one (✕), **Remove defeated** (Health below 0), **Clear encounter**
(`enemies_removed`). Not undoable, like the other GM tools; nothing appears in the change log or
on any other screen yet.

**Wiring**: `Bestiary` (in `enemies.ts`) holds the state and **plans** each action (validates and
returns the event, or null when nothing would change); `Session` owns it (`session.bestiary`,
reset in `rebuild()`, fed in `apply()`'s `default:` via `isEnemyEvent`) and logs the planned event
(`saveEnemyTemplate`, `spawnEnemies`, `updateEnemy`, `adjustEnemyPool`, `removeEnemies`, …).
**The screen** is one swap target, `<main id="bestiary">` (`hx-target="this"` inherited by all its
controls, requests queued with `hx-sync`): every route answers with the whole screen, and
pushes the same out of band to the **other** open Bestiary tabs. Those tabs are their own kind of
socket client (`/ws?bestiary=<tab id>`, `hub.addBestiary` / `hub.sendBestiary`, never reached by
the boards' `hub.send`); the tab id also goes out as the `X-Client` header, so the sending tab
isn't swapped twice — an out-of-band swap would drop the focus from the box being typed in, while
the normal swap restores it by the input's id (`en-<enemy>-<field>`).

### 6.6g Magic roll (`Magic` in session.ts)

User-designed. The GM's **"Start magic roll"** (with the other roll starters; `MagicDialog`,
`/gm/magic/start` → `startMagic`) picks a magnitude and a control ability (Intuition / Resolve by
default), an optional description, and the caster: a finished character, or **an NPC** with a name
and the two ranks the GM gives it. It is a challenge with `magic` set, and **sequential** like an
attack (`isSequential`; `rollsInPlay` gives one open roll at a time):
1. **Magnitude** (framing) against **0**: successes = `floor(result / 3)`, never below 0 (+3 = 1,
   +7 = 2), live (`magicMath`), so exertion on it can add one.
2. The caster presses **1 … N** (`MagicActivate`) to activate that many successes, which rolls
   **control** (resolution, `magic_control_rolled` → `rollMagicControl`) against **3 × activated**
   and locks the magnitude. Control shows its margin ("Controlled (+2)" / "Out of control (−1)").
Exertion, custom ±, Set die, support and the approach die work as in any challenge; the approach
die lands with the magnitude and can be cashed in during either step on the open roll. No success
= it fizzles and the GM can finish it straight away. An **NPC** caster (`magic.npc`,
`challengeRank` returns its ranks) is rolled by the GM (`/gm/magic/roll`, `/gm/magic/control`);
it has no exertion or approach — the GM's custom ± and Set die cover that. Unbreakable's gate: a
magnitude with no success, or a failed control, at the moment it was rolled. History log: "Mara
casts a wall of fire — 2 successes, 2 activated, control 7 vs 6 (+1)".

### 6.6f Trait-gated sections (Mystical / Supernatural → Magical Skills)

A section may carry **`requires_traits: [...]`** (rules.ts `Section.requiresTraits`, checked
against the trait list at load). A character who has **none** of those traits doesn't have the
section: it is left off their sheet (`GatedSection` renders an empty `#gated-<char>-<index>`
placeholder), its skills are left out of every skill picker (`skillsFor` in challenge.tsx —
challenge setup, group task, opposition) and the item modifier picker, and `train` refuses to
add points (taking points back is always allowed, e.g. after the trait is dropped). Session
helpers: `sectionVisible(char, section)`, `fieldVisible(char, fieldId)`; `setChallengePlayer` and
`setOppositionSkill` refuse a hidden skill. Picking or dropping a trait pushes every gated section
out of band (`gatedSections` in `pushTraits`), so it appears/disappears live. Only the first
trained section shows the skill-points bar (one Train toggle per sheet).

In rules.yaml (user-designed): trait category **Special** with **Mystical** (−1) and
**Supernatural** (−2), sharing the tag `supernatural_gift` (either/or) and with **no modifiers** —
their effect ("can use supernatural abilities", "+2 to their roll") is handled at the table (user
decision); description-only traits are now allowed. They unlock **Magical Skills**:
Shapeshifting, Fireweaving, Witchcraft, Benediction.

### 6.6e Combat: attacks both ways (`combat.ts`, `session.ts`, `views/combat.tsx`)

The GM decides **what attacks what** from each enemy's card on the Bestiary (user decision).

**Rules** (user-designed, in `combat.ts`): hit margin → tier — ≤−3 **miss** (no damage),
−2/−1 **glancing** (the highest damage die *rolled with the roll* is discarded — never one added
later), 0–2 **normal**, +3 **good** (+1 damage), +6 **great** (+2), +9 **critical** (one extra
damage die, not cumulative). Damage margin → wounds: below 0 none, then `1 + floor(m / 3)`
(light, normal, heavy, …, uncapped). **Spent Evasion**: once something is attacked in a round,
every later attack on it that round rolls against Evasion **0** (it can still miss or glance).
`Bestiary.round` / `attacked` track it; **Next round** (`combat_round_started`) refreshes
everyone, and emptying the encounter starts over at round 1. Speed-tie order is the GM's to run.

**A player attacks an enemy** = a **challenge** with `attack` set (`startAttack`, from the card's
"A player attacks …" form): framing is the **hit** (default Agility) against the enemy's Evasion
(or 0 when spent — the form's checkbox defaults to the current state), resolution the **damage**
(default Strength) against its Physical resistance. The GM may point either roll at another
defence and the wounds at Mind (user decision: "can be altered to be against different stats").
It is handed straight to the player, who picks skill/approach and rolls like any challenge —
exertion, approach dice, supporters, custom ± and Set die all work unchanged. `challengeMath`
branches to `attackMath`: item **Attack accuracy** adds to the hit, **Attack damage** to the
damage, the tier's effect is applied live (so exertion on the hit can lift a glancing blow and
the discarded die counts again); the critical die (`critDie`) is rolled with the dice and only
counts on a critical. **Sequential** (user decision): **Roll to hit** rolls the hit alone (and
the approach die); the player alters it (exertion +1 / reroll, custom ±, Set die, support, approach
taps), then presses **"Done with the hit — roll damage"** (`rollDamage` → `attack_damage_rolled`,
with the critical die), which **locks the hit** — from then on only the damage can be altered.
`rollsInPlay(ch)` is the one rule for that (an attack has one open roll at a time; `dieInPlay`,
exertion, custom, support and extra dice all check it); `attackStep(ch)` says `hit` / `damage`.
The **approach die** lands with the hit and can be activated in **either** step, acting on
whichever roll is open (so held until the damage, it can only touch the damage). Damage can't be
rolled while an approach effect waits for taps, nor on a miss — the GM finishes a miss straight
away. Unbreakable's "failing at the roll" is judged at each roll (hit, then damage = no wound).
The enemy's defence numbers are snapshotted at the start. **"Attack done"** (`challenge_closed` with
`wounds`) takes the wounds off the enemy. Board: "Mara attacks Wolf 1", two targets instead of
one difficulty (`AttackTargets`), Hit / Damage boxes, tier and wound captions.

**An enemy attacks a player** (`enemyAttack`, from "… attacks…"): **no active defence yet**, so
it simply happens (user decision): the enemy's dice (`rollDiceSide`, any count, rank-shifted)
+ bonus against the player's current Evasion (sheet value, items included; 0 when spent), damage
against their Physical resistance (or other defences the GM picks), and the wounds come straight
off Health/Mind (`enemy_attacked`, with `adj` like exertion's; a sheet pool stops at 0, so
`from`/`to` record what actually happened). The event keeps every number (`enemyAttackMath`).

**Screens**: `/table` gets `EncounterBoard` (`#encounter-board`): round, every enemy by **name
and condition only** (Unhurt / Wounded / Badly wounded / Down, "attacked" while its Evasion is
spent) — the numbers stay on the GM's Bestiary (user decision). Both kinds of attack go into the
table's history log (`AttackLogLine`, `EnemyAttackLogLine`). The Bestiary shows **Recent attacks**
(enemy attacks with their full dice). Pushes: Bestiary routes push the encounter to the table and
other Bestiary tabs (`pushEncounter`); an enemy attack also pushes the challenge board (log) and
the player's sheet; `pushChallenge` pushes the encounter while the current challenge is an attack.

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
