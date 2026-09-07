extends Control

## Two-step wizard: set each ability's difficulty, then its rank.
## Picking a difficulty is what puts an ability into the roll — there is no
## separate selection step.

signal wizard_completed(selections: Array)

const STEP_DIFFICULTY := 0
const STEP_RANKS := 1
const STEP_COUNT := 2

@onready var _title: Label = %Title
@onready var _subtitle: Label = %Subtitle
@onready var _content: VBoxContainer = %Content
@onready var _back_button: Button = %BackButton
@onready var _next_button: Button = %NextButton

var _step := STEP_DIFFICULTY
var _difficulties: Dictionary = {}
var _ranks: Dictionary = {}


func _ready() -> void:
	_back_button.pressed.connect(_on_back_pressed)
	_next_button.pressed.connect(_on_next_pressed)
	reset()


func reset() -> void:
	_step = STEP_DIFFICULTY
	_difficulties.clear()
	_ranks.clear()
	for ability in Dice.ABILITY_NAMES:
		_difficulties[ability] = Dice.NO_DIFFICULTY
		_ranks[ability] = Dice.AVERAGE_RANK
	_refresh()


## Abilities in the canonical order, so nothing shuffles around between steps.
func _rolled_abilities() -> Array[String]:
	var rolled: Array[String] = []
	for ability in Dice.ABILITY_NAMES:
		if _difficulties[ability] != Dice.NO_DIFFICULTY:
			rolled.append(ability)
	return rolled


func _refresh() -> void:
	for child in _content.get_children():
		child.queue_free()

	match _step:
		STEP_DIFFICULTY:
			_title.text = "How hard is each check?"
			_subtitle.text = "Step 1 of %d — set a difficulty for every ability you want to roll." % STEP_COUNT
			_build_difficulty_step()
		STEP_RANKS:
			_title.text = "How capable is each ability?"
			_subtitle.text = "Step 2 of %d — rank shifts every face of that ability's dice." % STEP_COUNT
			_build_rank_step()

	_back_button.disabled = _step == STEP_DIFFICULTY
	_next_button.text = "Next" if _step < STEP_COUNT - 1 else "Continue to roll"
	_update_next_enabled()


func _build_difficulty_step() -> void:
	for ability in Dice.ABILITY_NAMES:
		# Item ids are difficulty + 1, because OptionButton treats an id of -1 as
		# "auto-assign", which would collide NO_DIFFICULTY with the first difficulty.
		var picker := OptionButton.new()
		picker.custom_minimum_size.x = 240
		picker.add_item("— not rolled —", Dice.NO_DIFFICULTY + 1)
		for difficulty in Dice.DIFFICULTY_NAMES.size():
			picker.add_item("%s — %d" % [
				Dice.difficulty_name(difficulty), Dice.difficulty_target(difficulty)
			], difficulty + 1)
		picker.select(picker.get_item_index(_difficulties[ability] + 1))
		picker.item_selected.connect(_on_difficulty_selected.bind(ability, picker))
		_content.add_child(_labelled_row(ability, picker))


func _build_rank_step() -> void:
	for ability in _rolled_abilities():
		var picker := OptionButton.new()
		picker.custom_minimum_size.x = 240
		for rank in range(Dice.MIN_RANK, Dice.MAX_RANK + 1):
			picker.add_item("%d — %s" % [rank, Dice.rank_name(rank)], rank)
		picker.select(picker.get_item_index(_ranks[ability]))
		picker.item_selected.connect(_on_rank_selected.bind(ability, picker))

		var row := _labelled_row(ability, picker)

		var preview := Label.new()
		preview.name = "Preview"
		preview.add_theme_font_size_override("font_size", 16)
		preview.modulate = Color(1, 1, 1, 0.6)
		preview.text = _faces_preview(_ranks[ability])
		row.add_child(preview)

		_content.add_child(row)


func _labelled_row(ability: String, picker: OptionButton) -> HBoxContainer:
	var row := HBoxContainer.new()
	row.add_theme_constant_override("separation", 16)

	var label := Label.new()
	label.text = ability
	label.custom_minimum_size.x = 160
	label.add_theme_font_size_override("font_size", 20)
	row.add_child(label)
	row.add_child(picker)
	return row


func _faces_preview(rank: int) -> String:
	return "dice faces: %s" % Dice.faces_text(rank)


func _update_next_enabled() -> void:
	_next_button.disabled = _step == STEP_DIFFICULTY and _rolled_abilities().is_empty()


func _on_difficulty_selected(index: int, ability: String, picker: OptionButton) -> void:
	_difficulties[ability] = picker.get_item_id(index) - 1
	_update_next_enabled()


func _on_rank_selected(index: int, ability: String, picker: OptionButton) -> void:
	var rank := picker.get_item_id(index)
	_ranks[ability] = rank
	var preview := picker.get_parent().get_node_or_null("Preview") as Label
	if preview:
		preview.text = _faces_preview(rank)


func _on_back_pressed() -> void:
	if _step > STEP_DIFFICULTY:
		_step -= 1
		_refresh()


func _on_next_pressed() -> void:
	if _step < STEP_COUNT - 1:
		_step += 1
		_refresh()
		return

	var selections: Array = []
	for ability in _rolled_abilities():
		selections.append({
			"ability": ability,
			"rank": _ranks[ability],
			"difficulty": _difficulties[ability],
		})
	wizard_completed.emit(selections)
