extends Control

## Shows the wizard's picks, rolls them, and scores each ability against its
## own difficulty. Abilities are tallied separately — there is no combined total.

signal restart_requested

const SHUFFLE_STEPS := 12
const SHUFFLE_STEP_TIME := 0.045
const PASS_COLOR := Color(0.45, 0.82, 0.5)
const FAIL_COLOR := Color(0.91, 0.44, 0.42)

@onready var _summary: VBoxContainer = %Summary
@onready var _results: VBoxContainer = %Results
@onready var _roll_button: Button = %RollButton
@onready var _back_button: Button = %BackButton

var _selections: Array = []
var _stakes := Dice.DEFAULT_STAKES
var _rows: Array[Dictionary] = []
var _rolling := false
var _rng := RandomNumberGenerator.new()


func _ready() -> void:
	_rng.randomize()
	_roll_button.pressed.connect(_on_roll_pressed)
	_back_button.pressed.connect(func() -> void: restart_requested.emit())


func setup(selections: Array, stakes: int) -> void:
	_selections = selections
	_stakes = stakes
	_rolling = false
	_roll_button.disabled = false
	_roll_button.text = "ROLL"
	_build_summary()
	_build_result_rows()


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
		Dice.stakes_name(_stakes),
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


func _build_result_rows() -> void:
	for child in _results.get_children():
		child.queue_free()
	_rows.clear()

	for selection in _selections:
		var row := HBoxContainer.new()
		row.add_theme_constant_override("separation", 12)

		var icon := TextureRect.new()
		icon.texture = load(Dice.icon_path(selection["ability"]))
		icon.custom_minimum_size = Vector2(34, 34)
		icon.stretch_mode = TextureRect.STRETCH_KEEP_CENTERED
		row.add_child(icon)

		var name_label := Label.new()
		name_label.text = selection["ability"]
		name_label.custom_minimum_size.x = 120
		name_label.add_theme_font_size_override("font_size", 22)
		name_label.vertical_alignment = VERTICAL_ALIGNMENT_CENTER
		row.add_child(name_label)

		var dice_labels: Array[Label] = []
		for _i in Dice.DICE_PER_ABILITY:
			var die := Label.new()
			die.text = "—"
			die.custom_minimum_size.x = 145
			die.add_theme_font_size_override("font_size", 22)
			row.add_child(die)
			dice_labels.append(die)

		var total_label := Label.new()
		total_label.text = "= —"
		total_label.custom_minimum_size.x = 65
		total_label.add_theme_font_size_override("font_size", 24)
		row.add_child(total_label)

		var target_label := Label.new()
		target_label.text = "needs %d" % Dice.difficulty_target(selection["difficulty"])
		target_label.custom_minimum_size.x = 95
		target_label.add_theme_font_size_override("font_size", 18)
		target_label.modulate = Color(1, 1, 1, 0.6)
		row.add_child(target_label)

		var outcome_label := Label.new()
		outcome_label.text = ""
		outcome_label.custom_minimum_size.x = 150
		outcome_label.add_theme_font_size_override("font_size", 22)
		row.add_child(outcome_label)

		_results.add_child(row)
		_rows.append({
			"selection": selection,
			"dice": dice_labels,
			"total": total_label,
			"outcome": outcome_label,
		})


func _on_roll_pressed() -> void:
	if _rolling:
		return
	_rolling = true
	_roll_button.disabled = true
	_roll_button.text = "ROLLING…"

	var results := Dice.roll(_selections, _rng)
	await _shuffle_animation()
	_show_results(results)

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


func _show_results(results: Array) -> void:
	for i in results.size():
		var result: Dictionary = results[i]
		var row: Dictionary = _rows[i]
		var dice_labels: Array = row["dice"]
		for d in dice_labels.size():
			dice_labels[d].text = _die_text(result["dice"][d])
		row["total"].text = "= %d" % result["total"]

		var outcome: Label = row["outcome"]
		outcome.text = "%s  %+d" % ["PASSED" if result["passed"] else "FAILED", result["margin"]]
		outcome.modulate = PASS_COLOR if result["passed"] else FAIL_COLOR
