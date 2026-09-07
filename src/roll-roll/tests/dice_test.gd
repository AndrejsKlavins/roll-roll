extends SceneTree

## Headless checks for the dice rules.
## Run: Godot --headless --path . --script res://tests/dice_test.gd

var _failures := 0


func _check(condition: bool, description: String) -> void:
	if condition:
		print("  ok   %s" % description)
	else:
		_failures += 1
		printerr("  FAIL %s" % description)


func _initialize() -> void:
	print("dice rules")

	_check(Dice.modifier(1) == -2, "very weak is -2")
	_check(Dice.modifier(2) == -1, "weak is -1")
	_check(Dice.modifier(3) == 0, "average is unmodified")
	_check(Dice.modifier(4) == 1, "strong is +1")
	_check(Dice.modifier(5) == 2, "very strong is +2")

	_check(Dice.faces(3) == PackedInt32Array([1, 2, 3, 4, 5, 6]), "average faces are 1-6")
	_check(Dice.faces(1) == PackedInt32Array([-1, 0, 1, 2, 3, 4]), "very weak faces are shifted -2")
	_check(Dice.faces(5) == PackedInt32Array([3, 4, 5, 6, 7, 8]), "very strong faces are shifted +2")

	_check(Dice.face_name(1) == "Horrible", "one pip is Horrible")
	_check(Dice.face_name(3) == "Lacking", "three pips is Lacking")
	_check(Dice.face_name(6) == "Amazing", "six pips is Amazing")

	_check(Dice.difficulty_target(0) == 4, "Easy needs 4")
	_check(Dice.difficulty_target(1) == 8, "Challenging needs 8")
	_check(Dice.difficulty_target(2) == 12, "Hard needs 12")
	_check(Dice.difficulty_target(3) == 16, "Very hard needs 16")

	_check(Dice.difficulty_name(Dice.DEFAULT_DIFFICULTY) == "Challenging", "Challenging is the default difficulty")
	_check(Dice.stakes_name(Dice.DEFAULT_STAKES) == "Normal", "Normal is the default stakes")

	# A supporting ability sits two steps below the main one, floored at Easy.
	_check(Dice.supporting_difficulty(3) == 1, "Very hard supports at Challenging")
	_check(Dice.supporting_difficulty(2) == 0, "Hard supports at Easy")
	_check(Dice.supporting_difficulty(1) == 0, "Challenging supports at Easy, not below it")
	_check(Dice.supporting_difficulty(0) == 0, "Easy supports at Easy")

	_check(Dice.role_name(Dice.ROLE_MAIN) == "Main", "role 0 is the main ability")
	_check(Dice.role_name(Dice.ROLE_SUPPORTING) == "Supporting", "role 1 is the supporting ability")

	_check(Dice.SKILL_NAMES.size() == 6, "six skills are on offer")
	_check(Dice.skill_name(0) == "Athletics", "the first skill is Athletics")
	_check(Dice.skill_name(5) == "Ranged combat", "the last skill is Ranged combat")
	_check(Dice.NO_SKILL not in range(Dice.SKILL_NAMES.size()), "NO_SKILL is not a skill index")
	_check(Dice.DEFAULT_SKILL_SCORE == 1, "a newly added skill scores 1")

	var icons_present := true
	for ability in Dice.ABILITY_NAMES:
		if not ResourceLoader.exists(Dice.icon_path(ability)):
			icons_present = false
			printerr("  missing icon: %s" % Dice.icon_path(ability))
	_check(icons_present, "every ability has an icon")

	var rng := RandomNumberGenerator.new()
	rng.seed = 12345

	for rank in range(Dice.MIN_RANK, Dice.MAX_RANK + 1):
		var seen := {}
		var in_range := true
		var names_match := true
		for _i in 4000:
			var die := Dice.roll_die(rank, rng)
			seen[die["value"]] = true
			if die["value"] != die["pips"] + Dice.modifier(rank):
				in_range = false
			if die["face"] != Dice.FACE_NAMES[die["pips"] - 1]:
				names_match = false
		_check(in_range, "rank %d scores its pips plus the modifier" % rank)
		_check(names_match, "rank %d names the face that came up" % rank)
		_check(seen.size() == Dice.DIE_SIDES, "rank %d can produce all six faces" % rank)

	# A very strong Strength against Easy, a very weak Agility against Very hard.
	var selections := [
		{"ability": "Strength", "rank": 5, "difficulty": 0},
		{"ability": "Agility", "rank": 1, "difficulty": 3},
	]
	var results := Dice.roll(selections, rng)
	_check(results.size() == 2, "one result per rolled ability")

	var totals_match := true
	var dice_counts_match := true
	var margins_match := true
	var passes_match := true
	for i in results.size():
		var result: Dictionary = results[i]
		dice_counts_match = dice_counts_match and result["dice"].size() == Dice.DICE_PER_ABILITY
		var sum := 0
		for die in result["dice"]:
			sum += int(die["value"])
		totals_match = totals_match and sum == result["total"]
		margins_match = margins_match and result["margin"] == result["total"] - result["target"]
		passes_match = passes_match and result["passed"] == (result["margin"] >= 0)
		_check(result["ability"] == selections[i]["ability"], "result %d keeps its ability name" % i)
	_check(dice_counts_match, "%d dice rolled per ability" % Dice.DICE_PER_ABILITY)
	_check(totals_match, "each ability is tallied separately from its own dice")
	_check(margins_match, "margin is rolled minus required")
	_check(passes_match, "a check passes when it reaches its target")

	_check(results[0]["target"] == 4, "Strength was scored against Easy")
	_check(results[1]["target"] == 16, "Agility was scored against Very hard")
	# Very weak dice top out at 4 each, so 16 is out of reach.
	_check(not results[1]["passed"], "a very weak ability cannot pass Very hard")

	if _failures == 0:
		print("all checks passed")
	else:
		printerr("%d check(s) failed" % _failures)
	quit(1 if _failures > 0 else 0)
