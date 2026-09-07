class_name Dice
extends RefCounted

## Pure dice rules for the app. No UI, no scene tree — easy to unit test.

const STAT_NAMES: Array[String] = [
	"Strength",
	"Endurance",
	"Agility",
	"Perception",
	"Knowledge",
	"Intuition",
	"Resolve",
]

## Index 0 is strength level 1.
const STRENGTH_NAMES: Array[String] = [
	"Very weak",
	"Weak",
	"Average",
	"Strong",
	"Very strong",
]

const MIN_STRENGTH := 1
const MAX_STRENGTH := 5
const AVERAGE_STRENGTH := 3
const DIE_SIDES := 6
const DICE_PER_STAT := 2


static func strength_name(level: int) -> String:
	return STRENGTH_NAMES[clampi(level, MIN_STRENGTH, MAX_STRENGTH) - 1]


## Average is unmodified; every step away from it shifts all six faces by one.
static func modifier(level: int) -> int:
	return clampi(level, MIN_STRENGTH, MAX_STRENGTH) - AVERAGE_STRENGTH


static func faces(level: int) -> PackedInt32Array:
	var mod := modifier(level)
	var result := PackedInt32Array()
	for pips in range(1, DIE_SIDES + 1):
		result.append(pips + mod)
	return result


static func faces_text(level: int) -> String:
	var parts := PackedStringArray()
	for value in faces(level):
		parts.append(str(value))
	return ", ".join(parts)


static func roll_die(level: int, rng: RandomNumberGenerator) -> int:
	return rng.randi_range(1, DIE_SIDES) + modifier(level)


## selections: [{ "stat": String, "strength": int }, ...]
## returns:    [{ "stat": String, "strength": int, "dice": Array[int], "total": int }, ...]
static func roll(selections: Array, rng: RandomNumberGenerator) -> Array:
	var results: Array = []
	for selection in selections:
		var level: int = selection["strength"]
		var dice: Array[int] = []
		var total := 0
		for _i in DICE_PER_STAT:
			var value := roll_die(level, rng)
			dice.append(value)
			total += value
		results.append({
			"stat": selection["stat"],
			"strength": level,
			"dice": dice,
			"total": total,
		})
	return results
