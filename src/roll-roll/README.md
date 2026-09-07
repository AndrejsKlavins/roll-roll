# Roll Roll

A dice-rolling app for a 7-ability check system, built in Godot 4.7.

## Flow

1. **Wizard, step 1 — the check.** All seven abilities sit in a row as icon
   buttons. Drag one onto the **main ability** slot and, if the check has one,
   another onto the **supporting ability** slot. Dropping onto a filled slot
   replaces what was there; dropping an ability that already sits in the other
   slot swaps the two rather than duplicating it.

   A filled slot shows its four difficulty buttons, defaulting to Challenging.
   Choosing the main difficulty pulls the supporting one to two steps below it
   (never below Easy) — and if the supporting slot is still empty at that point,
   the derived value is applied when an ability is later dropped in. Either way
   the supporting difficulty can still be set by hand afterwards.

   **Stakes** (Low / Normal / High, Normal by default) are chosen once for the
   whole check.

   Stakes decide the boons and complications after the roll (below); the skill
   score becomes a pool of points to spend on the results (step 3).
2. **Wizard, step 2 — rank and skill.** Set each slotted ability's rank
   (1 Very weak … 5 Very strong), Average by default.

   The check's **special die archetype** is chosen here too — Exquisite,
   Unbreakable or Limitless, Exquisite by default. Each has its own face table
   (below).

   A single optional **skill** can be added here — one of Athletics, Acrobatics,
   Stealth, Manipulation, Melee combat or Ranged combat — with a score of 1-5.
   At most one skill applies to a check; adding one defaults to Athletics at 1,
   and it can be removed again.
3. **Roll screen.** Your selections are listed, with a big **ROLL** button
   underneath. Pressing it rolls, then scores each ability against its own
   difficulty.

   The player can **exert themselves** as often as they like: the button under
   the results offers either rerolling a single die — the four dice become
   selectable — or +1 to one result, chosen with the outlined `+1` button on
   each row (distinct from the grey skill stepper). Either choice can be
   cancelled up until it is made, and both re-score the check.

   Each exertion is logged as a chip on one scrolling row beside the button,
   which reads `Exert again` from the second one on. `+1`s stack, on the same
   ability or spread around. Rolling again clears the log and every bonus.

   If the check carries a skill, its score becomes a pool of points to spread
   across the results *after* the dice land. Each row gets a `-`/`+` stepper and
   the pool line says how many points are left. Every point added or taken back
   re-scores that ability — its total, its pass or fail, and the boons and
   complications for the whole check. Rolling again hands the whole pool back.
   Skill points and the exertion bonus stack; a total shows their sum, as
   `= 9 (+2)`.

## Difficulties

| Name        | Target |
|-------------|--------|
| Easy        | 4      |
| Challenging | 8      |
| Hard        | 12     |
| Very hard   | 16     |

A check passes when the ability's tally reaches its target. Each result shows
`PASSED` or `FAILED` plus the margin, `rolled - required`.

## The special die

One special die is thrown with every roll and reported on its own row under the
ability results. It has no rank and no target, **the exertion never touches it**
— neither a reroll nor a +1 reaches it, and it only changes when the whole roll
is thrown again. Nothing acts on its effects yet; the face is only named.

Each archetype has its own face table.

### Exquisite

| Pips | Face            | Effect                                                               |
|------|-----------------|----------------------------------------------------------------------|
| 1    | Blank           | —                                                                     |
| 2    | Tweak           | Lower one die, increase another                                       |
| 3-4  | Perfect balance | Rise the lowest die of your lowest ability roll to match the other one |
| 5-6  | Perfect choice  | discard 1 dice one ability, double of 1 dice of another               |

### Unbreakable

| Pips | Face                           | Effect                     |
|------|--------------------------------|----------------------------|
| 1    | Blank                          | —                          |
| 2    | Unshakable                     | ignore bad                 |
| 3-4  | Recall your source of strength | advance 2 dice by one side |
| 5-6  | Squash weakness                | set 2 dice to 3rd face     |

### Limitless

| Pips | Face               | Effect             |
|------|--------------------|--------------------|
| 1    | Blunder            | lose dice          |
| 2    | Blank              | —                  |
| 3    | Emotional Outburst | Reroll → Hindrance |
| 4    | Wreck it           | +R → Break         |
| 5    | Push too far       | +R → -1Res         |
| 6    | Lose your Head     | +2R → injury       |

## Stakes: boons and complications

After the roll, each ability's margin (`rolled - required`) is read again for
boons and complications:

| Stakes | Effect |
|--------|--------|
| Low    | Neither, whatever the margins |
| Normal | At most one of each: a margin of +3 or better anywhere is one boon, a margin of -3 or worse anywhere is one complication |
| High   | Every whole step of 3, on every check, added up — +6 is two boons, -6 is two complications |

Boons need a clean sweep: if any check fell short of its target, every boon is
cancelled (the roll screen says so). Complications are never cancelled.

## Dice rules

Every die has six sides, named after their pips:

| Pips | Face     |
|------|----------|
| 1    | Horrible |
| 2    | Poor     |
| 3    | Lacking  |
| 4    | Good     |
| 5    | Great    |
| 6    | Amazing  |

Average dice score `1, 2, 3, 4, 5, 6`; rank shifts *every* face by one step:

| Rank | Name        | Modifier | Scores             |
|------|-------------|----------|--------------------|
| 1    | Very weak   | -2       | -1, 0, 1, 2, 3, 4  |
| 2    | Weak        | -1       | 0, 1, 2, 3, 4, 5   |
| 3    | Average     | +0       | 1, 2, 3, 4, 5, 6   |
| 4    | Strong      | +1       | 2, 3, 4, 5, 6, 7   |
| 5    | Very strong | +2       | 3, 4, 5, 6, 7, 8   |

The face name comes from the pips, so a "Great" face on a very strong die scores 7.
You roll **2 dice per rolled ability**, and each ability is tallied on its own —
there is no combined total.

## Layout

- `scenes/main.tscn` - screen switcher (wizard <-> roll screen)
- `scenes/wizard_screen.tscn`, `scripts/wizard_screen.gd` - the two-step wizard
- `scenes/roll_screen.tscn`, `scripts/roll_screen.gd` - summary, roll button, results
- `scenes/ability_slot.tscn`, `scripts/ability_slot.gd` - a drop target plus its
  difficulty buttons
- `scripts/ability_button.gd` - a draggable ability chip
- `scripts/option_row.gd` - the horizontal exclusive-button rows
- `scripts/ui_styles.gd` - colours for the widgets built in code
- `scripts/dice.gd` - the rules, with no UI dependencies
- `icons/` - one SVG per ability
- `tests/dice_test.gd` - headless checks for those rules

## Running the tests

```
godot --headless --path . --script res://tests/dice_test.gd
```

Exits non-zero if a check fails.
