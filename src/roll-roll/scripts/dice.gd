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
const DIFFICULTY_TARGETS: Array[int] = [4, 7, 10, 13]
const NO_DIFFICULTY := -1
const DEFAULT_DIFFICULTY := 1

## A supporting ability is checked against an easier target than the main one.
const SUPPORTING_DIFFICULTY_STEPS := 2

## What is riding on the check. Chosen once, for the whole check.
const STAKES_NAMES: Array[String] = ["Low", "Normal", "High"]
const STAKES_LOW := 0
const STAKES_NORMAL := 1
const STAKES_HIGH := 2
const DEFAULT_STAKES := STAKES_NORMAL

## How far past its target a check has to land to be worth a boon, and how far
## short to cost a complication.
const OUTCOME_STEP := 3

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

## The special die's archetype, chosen once for the whole check. The three
## archetypes share one face table for now.
const ARCHETYPE_NAMES: Array[String] = ["Exquisite", "Unbreakable", "Limitless"]
const DEFAULT_ARCHETYPE := 0

## The special die's faces, by pips — one table per archetype. The effects are
## shown to the player but nothing acts on them yet.
const EXQUISITE_FACES: Array = [
	{"name": "Blank", "effect": ""},
	{"name": "Tweak", "effect": "Lower one die, increase another"},
	{
		"name": "Perfect balance",
		"effect": "Rise the lowest die of your lowest ability roll to match the other one",
	},
	{
		"name": "Perfect balance",
		"effect": "Rise the lowest die of your lowest ability roll to match the other one",
	},
	{
		"name": "Perfect choice",
		"effect": "discard 1 dice one ability, double of 1 dice of another",
	},
	{
		"name": "Perfect choice",
		"effect": "discard 1 dice one ability, double of 1 dice of another",
	},
]

const UNBREAKABLE_FACES: Array = [
	{"name": "Blank", "effect": ""},
	{"name": "Unshakable", "effect": "ignore bad"},
	{"name": "Recall your source of strength", "effect": "advance 2 dice by one side"},
	{"name": "Recall your source of strength", "effect": "advance 2 dice by one side"},
	{"name": "Squash weakness", "effect": "set 2 dice to 3rd face"},
	{"name": "Squash weakness", "effect": "set 2 dice to 3rd face"},
]

## This table arrived before the archetypes were split apart and is the one
## archetype still without a table of its own.
const LIMITLESS_FACES: Array = [
	{"name": "Blunder", "effect": "lose dice"},
	{"name": "Blank", "effect": ""},
	{"name": "Emotional Outburst", "effect": "Reroll → Hindrance"},
	{"name": "Wreck it", "effect": "+R → Break"},
	{"name": "Push too far", "effect": "+R → -1Res"},
	{"name": "Lose your Head", "effect": "+2R → injury"},
]

## In ARCHETYPE_NAMES order.
const SPECIAL_FACES: Array = [
	EXQUISITE_FACES,
	UNBREAKABLE_FACES,
	LIMITLESS_FACES,
]

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


static func archetype_name(archetype: int) -> String:
	return ARCHETYPE_NAMES[archetype]


static func special_face(archetype: int, pips: int) -> Dictionary:
	return SPECIAL_FACES[archetype][clampi(pips, 1, DIE_SIDES) - 1]


static func special_face_name(archetype: int, pips: int) -> String:
	return special_face(archetype, pips)["name"]


static func special_face_effect(archetype: int, pips: int) -> String:
	return special_face(archetype, pips)["effect"]


## { "pips": int, "name": String, "effect": String } — one throw of the special
## die. It has no rank and no target; it only reports what came up.
static func roll_special(archetype: int, rng: RandomNumberGenerator) -> Dictionary:
	var pips := rng.randi_range(1, DIE_SIDES)
	var face := special_face(archetype, pips)
	return {"pips": pips, "name": face["name"], "effect": face["effect"]}


## A rolled result with one of its dice thrown again, re-tallied and re-scored.
static func reroll_die(result: Dictionary, die_index: int, rng: RandomNumberGenerator) -> Dictionary:
	var rerolled := result.duplicate(true)
	var dice: Array = rerolled["dice"]
	dice[die_index] = roll_die(result["rank"], rng)

	var total := 0
	for die in dice:
		total += int(die["value"])
	var target: int = result["target"]
	rerolled["total"] = total
	rerolled["margin"] = total - target
	rerolled["passed"] = total >= target
	return rerolled


## A rolled result with skill points added to its total, re-scored against the
## same target.
static func boosted(result: Dictionary, points: int) -> Dictionary:
	var scored := result.duplicate()
	var target: int = result["target"]
	var total: int = int(result["total"]) + points
	scored["total"] = total
	scored["margin"] = total - target
	scored["passed"] = total >= target
	return scored


## Boons and complications earned by a set of rolled results.
##
## Low stakes carry neither. Normal stakes give at most one of each: a margin of
## +3 or better anywhere is a boon, a margin of -3 or worse anywhere is a
## complication. High stakes count every whole step of 3 on every check.
##
## Boons need a clean sweep — a single check that fell short of its target
## cancels all of them. Complications are never cancelled.
static func outcome(results: Array, stakes: int) -> Dictionary:
	var boons := 0
	var complications := 0
	var earned_boons := false
	var all_passed := true

	for result in results:
		if not result["passed"]:
			all_passed = false
		if stakes == STAKES_LOW:
			continue

		var margin: int = result["margin"]
		if margin >= OUTCOME_STEP:
			earned_boons = true
			boons += 1 if stakes == STAKES_NORMAL else margin / OUTCOME_STEP
		elif margin <= -OUTCOME_STEP:
			complications += 1 if stakes == STAKES_NORMAL else -margin / OUTCOME_STEP

	if stakes == STAKES_NORMAL:
		boons = mini(boons, 1)
		complications = mini(complications, 1)
	if not all_passed:
		boons = 0

	return {
		"boons": boons,
		"complications": complications,
		"boons_lost": earned_boons and not all_passed,
	}


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
