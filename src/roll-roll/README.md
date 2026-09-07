# Roll Roll

A dice-rolling app for a 7-stat system, built in Godot 4.7.

## Flow

1. **Wizard, step 1** — tick the stats you're rolling (Strength, Endurance, Agility,
   Perception, Knowledge, Intuition, Resolve).
2. **Wizard, step 2** — set each selected stat's strength (1 Very weak … 5 Very strong).
   The faces of that stat's dice are previewed as you choose.
3. **Roll screen** — your selections are listed, with a big **ROLL** button underneath.
   Pressing it rolls, then tallies each stat separately and shows a grand total.

## Dice rules

Every die has six sides. Average dice read `1, 2, 3, 4, 5, 6`; strength shifts *every*
face by one step:

| Level | Name        | Modifier | Faces              |
|-------|-------------|----------|--------------------|
| 1     | Very weak   | -2       | -1, 0, 1, 2, 3, 4  |
| 2     | Weak        | -1       | 0, 1, 2, 3, 4, 5   |
| 3     | Average     | +0       | 1, 2, 3, 4, 5, 6   |
| 4     | Strong      | +1       | 2, 3, 4, 5, 6, 7   |
| 5     | Very strong | +2       | 3, 4, 5, 6, 7, 8   |

You roll **2 dice per selected stat**, and each stat is tallied on its own.

## Layout

- `scenes/main.tscn` — screen switcher (wizard ⇄ roll screen)
- `scenes/wizard_screen.tscn`, `scripts/wizard_screen.gd` — the two-step wizard
- `scenes/roll_screen.tscn`, `scripts/roll_screen.gd` — summary, roll button, tallies
- `scripts/dice.gd` — the rules, with no UI dependencies
- `tests/dice_test.gd` — headless checks for those rules

## Running the tests

```
godot --headless --path . --script res://tests/dice_test.gd
```

Exits non-zero if a check fails.
