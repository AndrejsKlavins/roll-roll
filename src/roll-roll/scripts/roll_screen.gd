extends Control

## Shows the wizard's picks, rolls them, and scores each ability against its
## own difficulty. Abilities are tallied separately — there is no combined total.
##
## When the check carries a skill, its score becomes a pool of points that can
## be spread across the results afterwards to push totals over their targets.
## Every allocation re-scores the checks, and the boons and complications with
## them.

signal restart_requested

const SHUFFLE_STEPS := 12
const SHUFFLE_STEP_TIME := 0.045
const PASS_COLOR := Color(0.45, 0.82, 0.5)
const FAIL_COLOR := Color(0.91, 0.44, 0.42)
const MUTED_COLOR := Color(1, 1, 1, 0.65)

@onready var _summary: VBoxContainer = %Summary
@onready var _results: VBoxContainer = %Results
@onready var _outcome: Label = %Outcome
@onready var _roll_button: Button = %RollButton
@onready var _back_button: Button = %BackButton

var _check: Dictionary = {}
var _selections: Array = []
var _rows: Array[Dictionary] = []
var _rolled: Array = []
var _allocations: Array[int] = []
var _pool_label: Label
var _rolling := false
var _rng := RandomNumberGenerator.new()


func _ready() -> void:
	_rng.randomize()
	_roll_button.pressed.connect(_on_roll_pressed)
	_back_button.pressed.connect(func() -> void: restart_requested.emit())


func setup(check: Dictionary) -> void:
	_check = check
	_selections = check["selections"]
	_rolled = []
	_allocations.clear()
	for _i in _selections.size():
		_allocations.append(0)
	_rolling = false
	_roll_button.disabled = false
	_roll_button.text = "ROLL"
	_set_outcome("", Color(1, 1, 1))
	_build_summary()
	_build_result_rows()


func _has_skill() -> bool:
	return _check["skill"] != Dice.NO_SKILL


func _skill_pool() -> int:
	return _check["skill_score"] if _has_skill() else 0


func _spent() -> int:
	var spent := 0
	for amount in _allocations:
		spent += amount
	return spent


func _build_summary() -> void:
	for child in _summary.get_children():
		child.queue_free()

	var total_dice := _selections.size() * Dice.DICE_PER_ABILITY
	var heading := Label.new()
	heading.add_theme_font_size_override("font_size", 18)
	heading.text = "%d abilit%s — %d dice total   ·   %s stakes" % [
		_selections.size(),
		"y" if _selections.size() == 1 else "ies",
		total_dice,
		Dice.stakes_name(_check["stakes"]),
	]
	heading.modulate = Color(1, 1, 1, 0.7)
	_summary.add_child(heading)

	for selection in _selections:
		var rank: int = selection["rank"]
		var difficulty: int = selection["difficulty"]
		var line := Label.new()
		line.add_theme_font_size_override("font_size", 20)
		line.text = "%s · %s — %s (%+d)  vs  %s %d   %dd6: %s" % [
			Dice.role_name(selection["role"]),
			selection["ability"],
			Dice.rank_name(rank),
			Dice.modifier(rank),
			Dice.difficulty_name(difficulty),
			Dice.difficulty_target(difficulty),
			Dice.DICE_PER_ABILITY,
			Dice.faces_text(rank),
		]
		_summary.add_child(line)

	if _has_skill():
		var skill_line := Label.new()
		skill_line.add_theme_font_size_override("font_size", 20)
		skill_line.text = "Skill · %s %d" % [
			Dice.skill_name(_check["skill"]), _check["skill_score"]
		]
		_summary.add_child(skill_line)


func _build_result_rows() -> void:
	for child in _results.get_children():
		child.queue_free()
	_rows.clear()
	_pool_label = null

	if _has_skill():
		_pool_label = Label.new()
		_pool_label.add_theme_font_size_override("font_size", 17)
		_pool_label.modulate = MUTED_COLOR
		_results.add_child(_pool_label)

	for i in _selections.size():
		var selection: Dictionary = _selections[i]
		var row := HBoxContainer.new()
		row.add_theme_constant_override("separation", 8)

		var icon := TextureRect.new()
		icon.texture = load(Dice.icon_path(selection["ability"]))
		icon.custom_minimum_size = Vector2(34, 34)
		icon.stretch_mode = TextureRect.STRETCH_KEEP_CENTERED
		row.add_child(icon)

		var name_label := Label.new()
		name_label.text = selection["ability"]
		name_label.custom_minimum_size.x = 110
		name_label.add_theme_font_size_override("font_size", 22)
		name_label.vertical_alignment = VERTICAL_ALIGNMENT_CENTER
		row.add_child(name_label)

		var dice_labels: Array[Label] = []
		for _d in Dice.DICE_PER_ABILITY:
			var die := Label.new()
			die.text = "—"
			die.custom_minimum_size.x = 115
			die.add_theme_font_size_override("font_size", 20)
			die.vertical_alignment = VERTICAL_ALIGNMENT_CENTER
			row.add_child(die)
			dice_labels.append(die)

		var total_label := Label.new()
		total_label.text = "= —"
		total_label.custom_minimum_size.x = 105
		total_label.add_theme_font_size_override("font_size", 22)
		total_label.vertical_alignment = VERTICAL_ALIGNMENT_CENTER
		row.add_child(total_label)

		var stepper := {}
		if _has_skill():
			stepper = _build_stepper(i)
			row.add_child(stepper["box"])

		var target_label := Label.new()
		target_label.text = "needs %d" % Dice.difficulty_target(selection["difficulty"])
		target_label.custom_minimum_size.x = 78
		target_label.add_theme_font_size_override("font_size", 17)
		target_label.modulate = MUTED_COLOR
		target_label.vertical_alignment = VERTICAL_ALIGNMENT_CENTER
		row.add_child(target_label)

		var outcome_label := Label.new()
		outcome_label.custom_minimum_size.x = 122
		outcome_label.add_theme_font_size_override("font_size", 20)
		outcome_label.vertical_alignment = VERTICAL_ALIGNMENT_CENTER
		row.add_child(outcome_label)

		_results.add_child(row)
		_rows.append({
			"selection": selection,
			"dice": dice_labels,
			"total": total_label,
			"outcome": outcome_label,
			"stepper": stepper,
		})

	_render_allocation()


func _build_stepper(index: int) -> Dictionary:
	var box := HBoxContainer.new()
	box.add_theme_constant_override("separation", 4)
	box.custom_minimum_size.x = 92

	var minus := Button.new()
	minus.text = "-"
	minus.custom_minimum_size = Vector2(28, 28)
	minus.add_theme_font_size_override("font_size", 18)
	UiStyles.apply_stepper(minus)
	minus.pressed.connect(_on_allocate.bind(index, -1))
	box.add_child(minus)

	var amount := Label.new()
	amount.text = "0"
	amount.custom_minimum_size.x = 24
	amount.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	amount.vertical_alignment = VERTICAL_ALIGNMENT_CENTER
	amount.add_theme_font_size_override("font_size", 20)
	box.add_child(amount)

	var plus := Button.new()
	plus.text = "+"
	plus.custom_minimum_size = Vector2(28, 28)
	plus.add_theme_font_size_override("font_size", 18)
	UiStyles.apply_stepper(plus)
	plus.pressed.connect(_on_allocate.bind(index, 1))
	box.add_child(plus)

	return {"box": box, "minus": minus, "amount": amount, "plus": plus}


func _on_roll_pressed() -> void:
	if _rolling:
		return
	_rolling = true
	_roll_button.disabled = true
	_roll_button.text = "ROLLING…"
	_set_outcome("", Color(1, 1, 1))

	# A fresh roll hands the whole skill pool back.
	for i in _allocations.size():
		_allocations[i] = 0
	_rolled = []
	_render_allocation()

	var results := Dice.roll(_selections, _rng)
	await _shuffle_animation()
	_rolled = results
	_render_results()

	_rolling = false
	_roll_button.disabled = false
	_roll_button.text = "ROLL AGAIN"


## Flicker plausible faces so the result lands instead of just appearing.
func _shuffle_animation() -> void:
	for _step in SHUFFLE_STEPS:
		for row in _rows:
			var rank: int = row["selection"]["rank"]
			for die in row["dice"]:
				die.text = _die_text(Dice.roll_die(rank, _rng))
			row["total"].text = "= …"
			row["outcome"].text = ""
		await get_tree().create_timer(SHUFFLE_STEP_TIME).timeout


func _die_text(die: Dictionary) -> String:
	return "%s %d" % [die["face"], die["value"]]


## The rolled results with the allocated skill points folded in.
func _boosted_results() -> Array:
	var boosted: Array = []
	for i in _rolled.size():
		boosted.append(Dice.boosted(_rolled[i], _allocations[i]))
	return boosted


func _on_allocate(index: int, delta: int) -> void:
	var wanted: int = _allocations[index] + delta
	var remaining := _skill_pool() - _spent()
	if wanted < 0 or (delta > 0 and remaining <= 0):
		return
	_allocations[index] = wanted
	_render_results()


func _render_results() -> void:
	if _rolled.is_empty():
		_render_allocation()
		return

	var boosted := _boosted_results()
	for i in boosted.size():
		var result: Dictionary = boosted[i]
		var row: Dictionary = _rows[i]

		var dice_labels: Array = row["dice"]
		for d in dice_labels.size():
			dice_labels[d].text = _die_text(_rolled[i]["dice"][d])

		var spent: int = _allocations[i]
		var total_text := "= %d" % result["total"]
		if spent > 0:
			total_text += " (+%d)" % spent
		row["total"].text = total_text

		var outcome: Label = row["outcome"]
		outcome.text = "%s  %+d" % [
			"PASSED" if result["passed"] else "FAILED", result["margin"]
		]
		outcome.modulate = PASS_COLOR if result["passed"] else FAIL_COLOR

	_render_allocation()
	_show_outcome(boosted)


func _render_allocation() -> void:
	if not _has_skill():
		return

	var pool := _skill_pool()
	var remaining := pool - _spent()
	_pool_label.text = "%s %d   ·   %d of %d point%s left" % [
		Dice.skill_name(_check["skill"]), pool, remaining, pool, "" if pool == 1 else "s"
	]

	for i in _rows.size():
		var stepper: Dictionary = _rows[i]["stepper"]
		if stepper.is_empty():
			continue
		var spent: int = _allocations[i]
		stepper["amount"].text = str(spent)
		stepper["amount"].modulate = Color(1, 1, 1) if spent > 0 else MUTED_COLOR
		# Points can only be spread once the dice have actually landed.
		stepper["minus"].disabled = _rolled.is_empty() or spent == 0
		stepper["plus"].disabled = _rolled.is_empty() or remaining <= 0


func _show_outcome(results: Array) -> void:
	var stakes: int = _check["stakes"]
	if stakes == Dice.STAKES_LOW:
		_set_outcome("Low stakes — no bonuses or complications", MUTED_COLOR)
		return

	var tally := Dice.outcome(results, stakes)
	var boons: int = tally["boons"]
	var complications: int = tally["complications"]

	var parts := PackedStringArray()
	if boons > 0:
		parts.append("%d boon%s" % [boons, "" if boons == 1 else "s"])
	if complications > 0:
		parts.append("%d complication%s" % [
			complications, "" if complications == 1 else "s"
		])

	var color := MUTED_COLOR
	if boons > 0 and complications == 0:
		color = PASS_COLOR
	elif complications > 0 and boons == 0:
		color = FAIL_COLOR

	if parts.is_empty():
		parts.append("No boons or complications")
	var text := "   ·   ".join(parts)
	if tally["boons_lost"]:
		text += "   (no boons — a check fell short)"
	_set_outcome(text, color)


func _set_outcome(text: String, color: Color) -> void:
	_outcome.text = text
	_outcome.modulate = color
