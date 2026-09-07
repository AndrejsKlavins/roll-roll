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


## Fake results, so the outcome rules can be checked at exact margins.
func _margins(values: Array) -> Array:
	var results: Array = []
	for margin in values:
		results.append({"margin": margin, "passed": margin >= 0})
	return results


func _outcome(values: Array, stakes: int) -> String:
	var result := Dice.outcome(_margins(values), stakes)
	return "%d/%d" % [result["boons"], result["complications"]]


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

	print("the special die")

	_check(Dice.ARCHETYPE_NAMES.size() == 3, "three archetypes are on offer")
	_check(
		", ".join(Dice.ARCHETYPE_NAMES) == "Exquisite, Unbreakable, Limitless",
		"the archetypes are Exquisite, Unbreakable and Limitless"
	)
	_check(
		Dice.archetype_name(Dice.DEFAULT_ARCHETYPE) == "Exquisite",
		"Exquisite is the default archetype"
	)

	# Each archetype now has its own table.
	var exquisite := 0
	var unbreakable := 1
	var limitless := 2
	_check(Dice.archetype_name(exquisite) == "Exquisite", "archetype 0 is Exquisite")
	_check(Dice.archetype_name(unbreakable) == "Unbreakable", "archetype 1 is Unbreakable")
	_check(Dice.archetype_name(limitless) == "Limitless", "archetype 2 is Limitless")

	_check(Dice.special_face_name(exquisite, 1) == "Blank", "Exquisite: one pip is Blank")
	_check(Dice.special_face_effect(exquisite, 1) == "", "Exquisite: Blank carries no effect")
	_check(Dice.special_face_name(exquisite, 2) == "Tweak", "Exquisite: two pips is a Tweak")
	_check(
		Dice.special_face_effect(exquisite, 2) == "Lower one die, increase another",
		"Exquisite: a Tweak trades one die against another"
	)
	for pips in [3, 4]:
		_check(
			Dice.special_face_name(exquisite, pips) == "Perfect balance",
			"Exquisite: %d pips is Perfect balance" % pips
		)
	for pips in [5, 6]:
		_check(
			Dice.special_face_name(exquisite, pips) == "Perfect choice",
			"Exquisite: %d pips is Perfect choice" % pips
		)

	_check(Dice.special_face_name(unbreakable, 1) == "Blank", "Unbreakable: one pip is Blank")
	_check(
		Dice.special_face_name(unbreakable, 2) == "Unshakable",
		"Unbreakable: two pips is Unshakable"
	)
	_check(
		Dice.special_face_effect(unbreakable, 2) == "ignore bad",
		"Unbreakable: Unshakable ignores bad"
	)
	for pips in [3, 4]:
		_check(
			Dice.special_face_name(unbreakable, pips) == "Recall your source of strength",
			"Unbreakable: %d pips recalls your source of strength" % pips
		)
		_check(
			Dice.special_face_effect(unbreakable, pips) == "advance 2 dice by one side",
			"Unbreakable: %d pips advances 2 dice by one side" % pips
		)
	for pips in [5, 6]:
		_check(
			Dice.special_face_name(unbreakable, pips) == "Squash weakness",
			"Unbreakable: %d pips squashes weakness" % pips
		)
		_check(
			Dice.special_face_effect(unbreakable, pips) == "set 2 dice to 3rd face",
			"Unbreakable: %d pips sets 2 dice to the 3rd face" % pips
		)

	_check(Dice.special_face_name(limitless, 1) == "Blunder", "Limitless: one pip is a Blunder")
	_check(Dice.special_face_effect(limitless, 1) == "lose dice", "Limitless: a Blunder loses dice")
	_check(Dice.special_face_name(limitless, 2) == "Blank", "Limitless: two pips is Blank")
	_check(
		Dice.special_face_name(limitless, 6) == "Lose your Head",
		"Limitless: six pips is Lose your Head"
	)
	_check(
		Dice.special_face_effect(limitless, 6) == "+2R → injury",
		"Limitless: Lose your Head costs an injury"
	)

	var tables_differ := true
	for pips in range(1, Dice.DIE_SIDES + 1):
		if Dice.special_face_name(exquisite, pips) == Dice.special_face_name(limitless, pips):
			if pips != 2:  # both call the second face Blank
				tables_differ = false
	_check(tables_differ, "no two archetypes share a table any more")

	var every_face_filled := true
	for archetype in Dice.ARCHETYPE_NAMES.size():
		_check(
			Dice.SPECIAL_FACES[archetype].size() == Dice.DIE_SIDES,
			"%s has six faces" % Dice.archetype_name(archetype)
		)
		for pips in range(1, Dice.DIE_SIDES + 1):
			if Dice.special_face_name(archetype, pips) == "":
				every_face_filled = false
	_check(every_face_filled, "every face of every archetype is named")

	var special_rng := RandomNumberGenerator.new()
	special_rng.seed = 4242
	var faces_match := true
	for archetype in Dice.ARCHETYPE_NAMES.size():
		var special_seen := {}
		for _i in 2000:
			var special := Dice.roll_special(archetype, special_rng)
			var pips: int = special["pips"]
			special_seen[pips] = true
			if special["name"] != Dice.special_face_name(archetype, pips):
				faces_match = false
			if special["effect"] != Dice.special_face_effect(archetype, pips):
				faces_match = false
		_check(
			special_seen.size() == Dice.DIE_SIDES,
			"%s can show all six faces" % Dice.archetype_name(archetype)
		)
	_check(faces_match, "a special roll names its own archetype's face")

	print("exertion: rerolling a die")

	var reroll_rng := RandomNumberGenerator.new()
	reroll_rng.seed = 99
	var two_dice := {
		"ability": "Agility", "rank": 5, "difficulty": 1,
		"dice": [
			{"pips": 1, "face": "Horrible", "value": 3},
			{"pips": 6, "face": "Amazing", "value": 8},
		],
		"total": 11, "target": 8, "margin": 3, "passed": true,
	}

	var kept_faces := true
	var retallied := true
	var rescored := true
	var in_range := true
	for _i in 500:
		var thrown := Dice.reroll_die(two_dice, 0, reroll_rng)
		if thrown["dice"][1] != two_dice["dice"][1]:
			kept_faces = false
		var sum := 0
		for die in thrown["dice"]:
			sum += int(die["value"])
		if sum != thrown["total"]:
			retallied = false
		if thrown["margin"] != thrown["total"] - 8 or thrown["passed"] != (thrown["total"] >= 8):
			rescored = false
		var thrown_value: int = thrown["dice"][0]["value"]
		if thrown_value < 3 or thrown_value > 8:
			in_range = false
	_check(kept_faces, "rerolling one die leaves the other alone")
	_check(retallied, "the total is re-tallied from the dice")
	_check(rescored, "the margin and pass are re-scored after a reroll")
	_check(in_range, "the new die uses the ability's own rank")
	_check(two_dice["total"] == 11, "rerolling does not modify the original result")
	_check(
		two_dice["dice"][0]["value"] == 3,
		"rerolling does not modify the original result's dice"
	)

	print("skill points")

	var short_check := {"total": 7, "target": 8, "margin": -1, "passed": false}
	var unspent := Dice.boosted(short_check, 0)
	_check(unspent["total"] == 7 and not unspent["passed"], "no points leaves the result alone")
	var rescued := Dice.boosted(short_check, 1)
	_check(rescued["total"] == 8, "a point is added to the total")
	_check(rescued["margin"] == 0, "the margin is re-scored against the same target")
	_check(rescued["passed"], "a point can turn a near miss into a pass")
	var pushed := Dice.boosted(short_check, 4)
	_check(pushed["margin"] == 3, "points carry a result past its target")
	_check(short_check["total"] == 7, "boosting does not modify the rolled result")

	# Boosting is what makes a boon appear, so the two have to agree.
	var boosted_pair := [Dice.boosted(short_check, 1), Dice.boosted(short_check, 4)]
	_check(
		Dice.outcome(boosted_pair, Dice.STAKES_NORMAL)["boons"] == 1,
		"boons are re-counted from the boosted results"
	)

	print("stakes outcomes (boons/complications)")

	# Low stakes carry neither, however extreme the margins.
	_check(_outcome([9, -9], Dice.STAKES_LOW) == "0/0", "low stakes have no boons or complications")

	# Normal: one of each at most, at a margin of +/-3 inclusive.
	_check(_outcome([3], Dice.STAKES_NORMAL) == "1/0", "normal: +3 is a boon")
	_check(_outcome([2], Dice.STAKES_NORMAL) == "0/0", "normal: +2 is nothing")
	_check(_outcome([-3], Dice.STAKES_NORMAL) == "0/1", "normal: -3 is a complication")
	_check(_outcome([-2], Dice.STAKES_NORMAL) == "0/0", "normal: -2 is nothing")
	_check(_outcome([9], Dice.STAKES_NORMAL) == "1/0", "normal: a huge margin is still one boon")
	_check(_outcome([5, 4], Dice.STAKES_NORMAL) == "1/0", "normal: two good checks are still one boon")
	_check(_outcome([-5, -4], Dice.STAKES_NORMAL) == "0/1", "normal: two bad checks are still one complication")

	# High: every whole step of three, on every check, added up.
	_check(_outcome([3], Dice.STAKES_HIGH) == "1/0", "high: +3 is one boon")
	_check(_outcome([5], Dice.STAKES_HIGH) == "1/0", "high: +5 is still one boon")
	_check(_outcome([6], Dice.STAKES_HIGH) == "2/0", "high: +6 is two boons")
	_check(_outcome([9], Dice.STAKES_HIGH) == "3/0", "high: +9 is three boons")
	_check(_outcome([-6], Dice.STAKES_HIGH) == "0/2", "high: -6 is two complications")
	_check(_outcome([4, 3], Dice.STAKES_HIGH) == "2/0", "high: boons add up across checks")

	# A check that fell short cancels every boon, but never a complication.
	_check(_outcome([4, -4], Dice.STAKES_NORMAL) == "0/1", "normal: a failed check cancels the boon")
	_check(_outcome([9, -1], Dice.STAKES_HIGH) == "0/0", "high: a near miss still cancels every boon")
	_check(_outcome([9, -6], Dice.STAKES_HIGH) == "0/2", "high: complications survive a failed check")
	_check(_outcome([3, 0], Dice.STAKES_NORMAL) == "1/0", "a check that exactly meets its target is a pass")

	var lost := Dice.outcome(_margins([4, -1]), Dice.STAKES_NORMAL)
	_check(lost["boons_lost"], "a cancelled boon is reported as lost")
	var clean := Dice.outcome(_margins([1, 1]), Dice.STAKES_NORMAL)
	_check(not clean["boons_lost"], "nothing is reported lost when none was earned")

	if _failures == 0:
		print("all checks passed")
	else:
		printerr("%d check(s) failed" % _failures)
	quit(1 if _failures > 0 else 0)
