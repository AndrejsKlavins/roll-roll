extends Control

## Shows the wizard's picks, rolls them, and tallies each stat separately.

signal restart_requested

const SHUFFLE_STEPS := 12
const SHUFFLE_STEP_TIME := 0.045

@onready var _summary: VBoxContainer = %Summary
@onready var _results: VBoxContainer = %Results
@onready var _grand_total: Label = %GrandTotal
@onready var _roll_button: Button = %RollButton
@onready var _back_button: Button = %BackButton

var _selections: Array = []
var _rows: Array[Dictionary] = []
var _rolling := false
var _rng := RandomNumberGenerator.new()


func _ready() -> void:
	_rng.randomize()
	_roll_button.pressed.connect(_on_roll_pressed)
	_back_button.pressed.connect(func() -> void: restart_requested.emit())


func setup(selections: Array) -> void:
	_selections = selections
	_rolling = false
	_roll_button.disabled = false
	_roll_button.text = "ROLL"
	_grand_total.text = ""
	_build_summary()
	_build_result_rows()


func _build_summary() -> void:
	for child in _summary.get_children():
		child.queue_free()

	var total_dice := _selections.size() * Dice.DICE_PER_STAT
	var heading := Label.new()
	heading.add_theme_font_size_override("font_size", 18)
	heading.text = "%d stat%s — %d dice total" % [
		_selections.size(), "" if _selections.size() == 1 else "s", total_dice
	]
	heading.modulate = Color(1, 1, 1, 0.7)
	_summary.add_child(heading)

	for selection in _selections:
		var level: int = selection["strength"]
		var line := Label.new()
		line.add_theme_font_size_override("font_size", 20)
		line.text = "%s — %s (%+d)   %dd6: %s" % [
			selection["stat"],
			Dice.strength_name(level),
			Dice.modifier(level),
			Dice.DICE_PER_STAT,
			Dice.faces_text(level),
		]
		_summary.add_child(line)


func _build_result_rows() -> void:
	for child in _results.get_children():
		child.queue_free()
	_rows.clear()

	for selection in _selections:
		var row := HBoxContainer.new()
		row.add_theme_constant_override("separation", 12)

		var name_label := Label.new()
		name_label.text = selection["stat"]
		name_label.custom_minimum_size.x = 160
		name_label.add_theme_font_size_override("font_size", 22)
		row.add_child(name_label)

		var dice_labels: Array[Label] = []
		for _i in Dice.DICE_PER_STAT:
			var die := Label.new()
			die.text = "?"
			die.custom_minimum_size.x = 52
			die.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
			die.add_theme_font_size_override("font_size", 26)
			row.add_child(die)
			dice_labels.append(die)

		var total_label := Label.new()
		total_label.text = "= —"
		total_label.custom_minimum_size.x = 90
		total_label.add_theme_font_size_override("font_size", 26)
		row.add_child(total_label)

		_results.add_child(row)
		_rows.append({
			"selection": selection,
			"dice": dice_labels,
			"total": total_label,
		})


func _on_roll_pressed() -> void:
	if _rolling:
		return
	_rolling = true
	_roll_button.disabled = true
	_roll_button.text = "ROLLING…"
	_grand_total.text = ""

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
			var level: int = row["selection"]["strength"]
			for die in row["dice"]:
				die.text = str(Dice.roll_die(level, _rng))
			row["total"].text = "= …"
		await get_tree().create_timer(SHUFFLE_STEP_TIME).timeout


func _show_results(results: Array) -> void:
	var grand := 0
	for i in results.size():
		var result: Dictionary = results[i]
		var row: Dictionary = _rows[i]
		var dice_labels: Array = row["dice"]
		for d in dice_labels.size():
			dice_labels[d].text = str(result["dice"][d])
		row["total"].text = "= %d" % result["total"]
		grand += result["total"]

	_grand_total.text = "Grand total: %d" % grand
