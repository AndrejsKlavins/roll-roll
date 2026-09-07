# Roll Roll

A dice-rolling app for a 7-ability check system, built in Godot 4.7.

## Flow

1. **Wizard, step 1 — difficulty.** Every ability (Strength, Endurance, Agility,
   Perception, Knowledge, Intuition, Resolve) gets a difficulty, or stays
   *not rolled*. Choosing a difficulty is what puts an ability into the roll.
2. **Wizard, step 2 — rank.** Set each rolled ability's rank (1 Very weak …
   5 Very strong). The faces of that ability's dice are previewed as you choose.
3. **Roll screen.** Your selections are listed, with a big **ROLL** button underneath.
   Pressing it rolls, then scores each ability against its own difficulty.

## Difficulties

| Name        | Target |
|-------------|--------|
| Easy        | 4      |
| Challenging | 8      |
| Hard        | 12     |
| Very hard   | 16     |

A check passes when the ability's tally reaches its target. Each result shows
`PASSED` or `FAILED` plus the margin, `rolled - required`.

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
- `scripts/dice.gd` - the rules, with no UI dependencies
- `tests/dice_test.gd` - headless checks for those rules

## Running the tests

```
godot --headless --path . --script res://tests/dice_test.gd
```

Exits non-zero if a check fails.
