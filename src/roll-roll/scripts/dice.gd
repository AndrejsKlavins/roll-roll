class_name Dice
extends RefCounted

## Pure dice rules for the app. No UI, no scene tree — easy to unit test.

const ABILITY_NAMES: Array[String] = [
	"Strength",
	"Endurance",
	"Agility",
	"Perception",
	"Knowledge",
	"Intuition",
	"Resolve",
]

## Index 0 is rank 1.
const RANK_NAMES: Array[String] = [
	"Very weak",
	"Weak",
	"Average",
	"Strong",
	"Very strong",
]

## Index 0 is the face showing one pip. Named after the pips, not the rolled value,
## so a "Great" face is the fifth face whatever the rank shifts it to.
const FACE_NAMES: Array[String] = [
	"Horrible",
	"Poor",
	"Lacking",
	"Good",
	"Great",
	"Amazing",
]

## Difficulties, by index. A check passes when the ability's tally reaches its target.
const DIFFICULTY_NAMES: Array[String] = [
	"Easy",
	"Challenging",
	"Hard",
	"Very hard",
]
const DIFFICULTY_TARGETS: Array[int] = [4, 8, 12, 16]
const NO_DIFFICULTY := -1
const DEFAULT_DIFFICULTY := 1

## A supporting ability is checked against an easier target than the main one.
const SUPPORTING_DIFFICULTY_STEPS := 2

## What is riding on the check. Chosen once, for the whole check.
const STAKES_NAMES: Array[String] = ["Low", "Normal", "High"]
const DEFAULT_STAKES := 1

## An optional skill, chosen once for the whole check. At most one applies.
const SKILL_NAMES: Array[String] = [
	"Athletics",
	"Acrobatics",
	"Stealth",
	"Manipulation",
	"Melee combat",
	"Ranged combat",
]
const MIN_SKILL_SCORE := 1
const MAX_SKILL_SCORE := 5
const DEFAULT_SKILL_SCORE := 1
const NO_SKILL := -1

const ROLE_MAIN := 0
const ROLE_SUPPORTING := 1
const ROLE_NAMES: Array[String] = ["Main", "Supporting"]

const MIN_RANK := 1
const MAX_RANK := 5
const AVERAGE_RANK := 3
const DIE_SIDES := 6
const DICE_PER_ABILITY := 2


static func rank_name(rank: int) -> String:
	return RANK_NAMES[clampi(rank, MIN_RANK, MAX_RANK) - 1]


static func face_name(pips: int) -> String:
	return FACE_NAMES[clampi(pips, 1, DIE_SIDES) - 1]


static func difficulty_name(difficulty: int) -> String:
	return DIFFICULTY_NAMES[difficulty]


static func difficulty_target(difficulty: int) -> int:
	return DIFFICULTY_TARGETS[difficulty]


## Two steps below the main ability's difficulty, never below the easiest one.
static func supporting_difficulty(main_difficulty: int) -> int:
	return maxi(0, main_difficulty - SUPPORTING_DIFFICULTY_STEPS)


static func stakes_name(stakes: int) -> String:
	return STAKES_NAMES[stakes]


static func role_name(role: int) -> String:
	return ROLE_NAMES[role]


static func skill_name(skill: int) -> String:
	return SKILL_NAMES[skill]


static func icon_path(ability: String) -> String:
	return "res://icons/%s.svg" % ability.to_lower()


## Average is unmodified; every step away from it shifts all six faces by one.
static func modifier(rank: int) -> int:
	return clampi(rank, MIN_RANK, MAX_RANK) - AVERAGE_RANK


static func faces(rank: int) -> PackedInt32Array:
	var mod := modifier(rank)
	var result := PackedInt32Array()
	for pips in range(1, DIE_SIDES + 1):
		result.append(pips + mod)
	return result


static func faces_text(rank: int) -> String:
	var parts := PackedStringArray()
	for value in faces(rank):
		parts.append(str(value))
	return ", ".join(parts)


## { "pips": int, "face": String, "value": int } — the face that came up and what it scores.
static func roll_die(rank: int, rng: RandomNumberGenerator) -> Dictionary:
	var pips := rng.randi_range(1, DIE_SIDES)
	return {
		"pips": pips,
		"face": face_name(pips),
		"value": pips + modifier(rank),
	}


## selections: [{ "ability": String, "rank": int, "difficulty": int }, ...]
## returns each of those plus "dice", "total", "target", "margin" and "passed".
static func roll(selections: Array, rng: RandomNumberGenerator) -> Array:
	var results: Array = []
	for selection in selections:
		var rank: int = selection["rank"]
		var target := difficulty_target(selection["difficulty"])
		var dice: Array[Dictionary] = []
		var total := 0
		for _i in DICE_PER_ABILITY:
			var die := roll_die(rank, rng)
			dice.append(die)
			total += int(die["value"])
		results.append({
			"ability": selection["ability"],
			"rank": rank,
			"difficulty": selection["difficulty"],
			"dice": dice,
			"total": total,
			"target": target,
			"margin": total - target,
			"passed": total >= target,
		})
	return results
