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

	var rng := RandomNumberGenerator.new()
	rng.seed = 12345

	for level in range(Dice.MIN_STRENGTH, Dice.MAX_STRENGTH + 1):
		var seen := {}
		var in_range := true
		for _i in 4000:
			var value := Dice.roll_die(level, rng)
			seen[value] = true
			if value < 1 + Dice.modifier(level) or value > Dice.DIE_SIDES + Dice.modifier(level):
				in_range = false
		_check(in_range, "level %d rolls stay inside its faces" % level)
		_check(seen.size() == Dice.DIE_SIDES, "level %d can produce all six faces" % level)

	var selections := [
		{"stat": "Strength", "strength": 5},
		{"stat": "Agility", "strength": 1},
	]
	var results := Dice.roll(selections, rng)
	_check(results.size() == 2, "one result per selected stat")

	var totals_match := true
	var dice_counts_match := true
	for i in results.size():
		var result: Dictionary = results[i]
		dice_counts_match = dice_counts_match and result["dice"].size() == Dice.DICE_PER_STAT
		var sum := 0
		for value in result["dice"]:
			sum += value
		totals_match = totals_match and sum == result["total"]
		_check(result["stat"] == selections[i]["stat"], "result %d keeps its stat name" % i)
	_check(dice_counts_match, "%d dice rolled per stat" % Dice.DICE_PER_STAT)
	_check(totals_match, "each stat is tallied separately from its own dice")

	if _failures == 0:
		print("all checks passed")
	else:
		printerr("%d check(s) failed" % _failures)
	quit(1 if _failures > 0 else 0)
