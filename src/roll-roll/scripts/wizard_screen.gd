extends Control

## Two-step wizard.
##
## Step 1 builds the check: drag an ability into the main slot and (optionally)
## the supporting one, give each a difficulty, and set the stakes.
## Step 2 sets the rank of whichever abilities ended up in the slots.

signal wizard_completed(selections: Array, stakes: int)

const STEP_CHECK := 0
const STEP_RANKS := 1
const STEP_COUNT := 2
const SLOT_SCENE := preload("res://scenes/ability_slot.tscn")
const SLOT_TITLES := ["Main ability", "Supporting ability"]

@onready var _title: Label = %Title
@onready var _subtitle: Label = %Subtitle
@onready var _content: VBoxContainer = %Content
@onready var _back_button: Button = %BackButton
@onready var _next_button: Button = %NextButton

var _step := STEP_CHECK
var _stakes := Dice.DEFAULT_STAKES
var _slot_abilities := ["", ""]
var _slot_difficulties := [Dice.DEFAULT_DIFFICULTY, Dice.DEFAULT_DIFFICULTY]
var _ranks: Dictionary = {}
var _slots: Array[AbilitySlot] = []


func _ready() -> void:
	_back_button.pressed.connect(_on_back_pressed)
	_next_button.pressed.connect(_on_next_pressed)
	reset()


func reset() -> void:
	_step = STEP_CHECK
	_stakes = Dice.DEFAULT_STAKES
	_slot_abilities = ["", ""]
	_slot_difficulties = [Dice.DEFAULT_DIFFICULTY, Dice.DEFAULT_DIFFICULTY]
	_ranks.clear()
	for ability in Dice.ABILITY_NAMES:
		_ranks[ability] = Dice.AVERAGE_RANK
	_refresh()


## Filled slots, main first. The roll follows this order everywhere after.
func _filled_roles() -> Array[int]:
	var roles: Array[int] = []
	for role in [Dice.ROLE_MAIN, Dice.ROLE_SUPPORTING]:
		if _slot_abilities[role] != "":
			roles.append(role)
	return roles


func _refresh() -> void:
	for child in _content.get_children():
		child.queue_free()
	_slots.clear()

	match _step:
		STEP_CHECK:
			_title.text = "Set up the check"
			_subtitle.text = "Step 1 of %d — drag an ability onto a slot, then pick how hard the check is." % STEP_COUNT
			_build_check_step()
		STEP_RANKS:
			_title.text = "How capable is each ability?"
			_subtitle.text = "Step 2 of %d — rank shifts every face of that ability's dice." % STEP_COUNT
			_build_rank_step()

	_back_button.disabled = _step == STEP_CHECK
	_next_button.text = "Next" if _step < STEP_COUNT - 1 else "Continue to roll"
	_update_next_enabled()


func _build_check_step() -> void:
	_content.add_child(_build_stakes_row())

	var slot_row := HBoxContainer.new()
	slot_row.add_theme_constant_override("separation", 16)
	for role in [Dice.ROLE_MAIN, Dice.ROLE_SUPPORTING]:
		var slot: AbilitySlot = SLOT_SCENE.instantiate()
		slot.size_flags_horizontal = Control.SIZE_EXPAND_FILL
		slot.setup(SLOT_TITLES[role], _slot_abilities[role], _slot_difficulties[role])
		slot.ability_dropped.connect(_on_ability_dropped.bind(role))
		slot.difficulty_pressed.connect(_on_difficulty_pressed.bind(role))
		slot_row.add_child(slot)
		_slots.append(slot)
	_content.add_child(slot_row)

	_content.add_child(HSeparator.new())

	var caption := Label.new()
	caption.text = "Abilities"
	caption.modulate = Color(1, 1, 1, 0.6)
	caption.add_theme_font_size_override("font_size", 15)
	_content.add_child(caption)

	var ability_row := HBoxContainer.new()
	ability_row.add_theme_constant_override("separation", 6)
	for ability in Dice.ABILITY_NAMES:
		var button := AbilityButton.create(ability)
		button.size_flags_horizontal = Control.SIZE_EXPAND_FILL
		ability_row.add_child(button)
	_content.add_child(ability_row)


func _build_stakes_row() -> HBoxContainer:
	var row := HBoxContainer.new()
	row.add_theme_constant_override("separation", 12)

	var label := Label.new()
	label.text = "Stakes"
	label.custom_minimum_size.x = 90
	label.add_theme_font_size_override("font_size", 18)
	row.add_child(label)

	var options := OptionRow.create(Dice.STAKES_NAMES, _stakes, 16)
	options.option_pressed.connect(func(index: int) -> void: _stakes = index)
	row.add_child(options)
	return row


func _build_rank_step() -> void:
	for role in _filled_roles():
		var ability: String = _slot_abilities[role]

		var row := HBoxContainer.new()
		row.add_theme_constant_override("separation", 16)

		var icon := TextureRect.new()
		icon.texture = load(Dice.icon_path(ability))
		icon.custom_minimum_size = Vector2(40, 40)
		icon.stretch_mode = TextureRect.STRETCH_KEEP_CENTERED
		row.add_child(icon)

		var label := Label.new()
		label.text = "%s  (%s)" % [ability, Dice.role_name(role).to_lower()]
		label.custom_minimum_size.x = 230
		label.add_theme_font_size_override("font_size", 20)
		label.vertical_alignment = VERTICAL_ALIGNMENT_CENTER
		row.add_child(label)

		var picker := OptionButton.new()
		picker.custom_minimum_size.x = 220
		for rank in range(Dice.MIN_RANK, Dice.MAX_RANK + 1):
			picker.add_item("%d — %s" % [rank, Dice.rank_name(rank)], rank)
		picker.select(picker.get_item_index(_ranks[ability]))
		picker.item_selected.connect(_on_rank_selected.bind(ability, picker))
		row.add_child(picker)

		var preview := Label.new()
		preview.name = "Preview"
		preview.add_theme_font_size_override("font_size", 16)
		preview.modulate = Color(1, 1, 1, 0.6)
		preview.text = _faces_preview(_ranks[ability])
		preview.vertical_alignment = VERTICAL_ALIGNMENT_CENTER
		row.add_child(preview)

		_content.add_child(row)


func _faces_preview(rank: int) -> String:
	return "dice faces: %s" % Dice.faces_text(rank)


func _update_next_enabled() -> void:
	_next_button.disabled = _step == STEP_CHECK and _slot_abilities[Dice.ROLE_MAIN] == ""


## Dropping an ability that already sits in the other slot swaps the two rather
## than putting the same ability on both sides of the check.
func _on_ability_dropped(dropped: String, role: int) -> void:
	var other := Dice.ROLE_SUPPORTING if role == Dice.ROLE_MAIN else Dice.ROLE_MAIN
	var previous: String = _slot_abilities[role]
	if _slot_abilities[other] == dropped:
		_slot_abilities[other] = previous
	_slot_abilities[role] = dropped

	var filling_empty_support := role == Dice.ROLE_SUPPORTING and previous == ""
	if filling_empty_support and _slot_abilities[Dice.ROLE_MAIN] != "":
		_slot_difficulties[Dice.ROLE_SUPPORTING] = Dice.supporting_difficulty(
			_slot_difficulties[Dice.ROLE_MAIN]
		)
	_refresh()


## Choosing the main difficulty pulls the supporting one down with it; the
## supporting slot can still be set by hand afterwards.
func _on_difficulty_pressed(difficulty: int, role: int) -> void:
	_slot_difficulties[role] = difficulty
	if role == Dice.ROLE_MAIN:
		var supporting := Dice.supporting_difficulty(difficulty)
		_slot_difficulties[Dice.ROLE_SUPPORTING] = supporting
		_slots[Dice.ROLE_SUPPORTING].set_difficulty(supporting)


func _on_rank_selected(index: int, ability: String, picker: OptionButton) -> void:
	var rank := picker.get_item_id(index)
	_ranks[ability] = rank
	var preview := picker.get_parent().get_node_or_null("Preview") as Label
	if preview:
		preview.text = _faces_preview(rank)


func _on_back_pressed() -> void:
	if _step > STEP_CHECK:
		_step -= 1
		_refresh()


func _on_next_pressed() -> void:
	if _step < STEP_COUNT - 1:
		_step += 1
		_refresh()
		return

	var selections: Array = []
	for role in _filled_roles():
		var ability: String = _slot_abilities[role]
		selections.append({
			"ability": ability,
			"rank": _ranks[ability],
			"difficulty": _slot_difficulties[role],
			"role": role,
		})
	wizard_completed.emit(selections, _stakes)
