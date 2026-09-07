extends Control

## Two-step wizard: pick the stats to roll, then set each stat's strength.

signal wizard_completed(selections: Array)

const STEP_STATS := 0
const STEP_STRENGTHS := 1
const STEP_COUNT := 2

@onready var _title: Label = %Title
@onready var _subtitle: Label = %Subtitle
@onready var _content: VBoxContainer = %Content
@onready var _back_button: Button = %BackButton
@onready var _next_button: Button = %NextButton

var _step := STEP_STATS
var _checked: Dictionary = {}
var _strengths: Dictionary = {}


func _ready() -> void:
	_back_button.pressed.connect(_on_back_pressed)
	_next_button.pressed.connect(_on_next_pressed)
	reset()


func reset() -> void:
	_step = STEP_STATS
	_checked.clear()
	_strengths.clear()
	for stat in Dice.STAT_NAMES:
		_checked[stat] = false
		_strengths[stat] = Dice.AVERAGE_STRENGTH
	_refresh()


## Stats in the canonical order, so the summary never shuffles around.
func _selected_stats() -> Array[String]:
	var selected: Array[String] = []
	for stat in Dice.STAT_NAMES:
		if _checked[stat]:
			selected.append(stat)
	return selected


func _refresh() -> void:
	for child in _content.get_children():
		child.queue_free()

	match _step:
		STEP_STATS:
			_title.text = "Which stats are you rolling?"
			_subtitle.text = "Step 1 of %d — pick one or more. You roll %d dice for each." % [
				STEP_COUNT, Dice.DICE_PER_STAT
			]
			_build_stat_step()
		STEP_STRENGTHS:
			_title.text = "How strong is each stat?"
			_subtitle.text = "Step 2 of %d — strength shifts every face of that stat's dice." % STEP_COUNT
			_build_strength_step()

	_back_button.disabled = _step == STEP_STATS
	_next_button.text = "Next" if _step < STEP_COUNT - 1 else "Continue to roll"
	_update_next_enabled()


func _build_stat_step() -> void:
	for stat in Dice.STAT_NAMES:
		var check := CheckBox.new()
		check.text = stat
		check.button_pressed = _checked[stat]
		check.add_theme_font_size_override("font_size", 20)
		check.toggled.connect(_on_stat_toggled.bind(stat))
		_content.add_child(check)


func _build_strength_step() -> void:
	for stat in _selected_stats():
		var row := HBoxContainer.new()
		row.add_theme_constant_override("separation", 16)

		var label := Label.new()
		label.text = stat
		label.custom_minimum_size.x = 160
		label.add_theme_font_size_override("font_size", 20)
		row.add_child(label)

		var picker := OptionButton.new()
		picker.custom_minimum_size.x = 200
		for level in range(Dice.MIN_STRENGTH, Dice.MAX_STRENGTH + 1):
			picker.add_item("%d — %s" % [level, Dice.strength_name(level)], level)
		picker.select(picker.get_item_index(_strengths[stat]))
		picker.item_selected.connect(_on_strength_selected.bind(stat, picker))
		row.add_child(picker)

		var preview := Label.new()
		preview.name = "Preview"
		preview.add_theme_font_size_override("font_size", 16)
		preview.modulate = Color(1, 1, 1, 0.6)
		preview.text = _faces_preview(_strengths[stat])
		row.add_child(preview)

		_content.add_child(row)


func _faces_preview(level: int) -> String:
	return "dice faces: %s" % Dice.faces_text(level)


func _update_next_enabled() -> void:
	_next_button.disabled = _step == STEP_STATS and _selected_stats().is_empty()


func _on_stat_toggled(pressed: bool, stat: String) -> void:
	_checked[stat] = pressed
	_update_next_enabled()


func _on_strength_selected(index: int, stat: String, picker: OptionButton) -> void:
	var level := picker.get_item_id(index)
	_strengths[stat] = level
	var preview := picker.get_parent().get_node_or_null("Preview") as Label
	if preview:
		preview.text = _faces_preview(level)


func _on_back_pressed() -> void:
	if _step > STEP_STATS:
		_step -= 1
		_refresh()


func _on_next_pressed() -> void:
	if _step < STEP_COUNT - 1:
		_step += 1
		_refresh()
		return

	var selections: Array = []
	for stat in _selected_stats():
		selections.append({"stat": stat, "strength": _strengths[stat]})
	wizard_completed.emit(selections)
