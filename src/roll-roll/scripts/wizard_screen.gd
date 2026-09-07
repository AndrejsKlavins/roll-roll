extends Control

## Two-step wizard.
##
## Step 1 builds the check: drag an ability into the main slot and (optionally)
## the supporting one, give each a difficulty, and set the stakes.
## Step 2 sets the rank of whichever abilities ended up in the slots.

signal wizard_completed(check: Dictionary)

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
var _archetype := Dice.DEFAULT_ARCHETYPE
var _skill := Dice.NO_SKILL
var _skill_score := Dice.DEFAULT_SKILL_SCORE
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
	_archetype = Dice.DEFAULT_ARCHETYPE
	_skill = Dice.NO_SKILL
	_skill_score = Dice.DEFAULT_SKILL_SCORE
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
		label.custom_minimum_size.x = 210
		label.add_theme_font_size_override("font_size", 20)
		label.vertical_alignment = VERTICAL_ALIGNMENT_CENTER
		row.add_child(label)

		var ranks := OptionRow.create(_rank_labels(), _ranks[ability] - Dice.MIN_RANK, 14)
		ranks.size_flags_horizontal = Control.SIZE_EXPAND_FILL
		ranks.option_pressed.connect(_on_rank_pressed.bind(ability))
		row.add_child(ranks)

		_content.add_child(row)

	_content.add_child(HSeparator.new())
	_content.add_child(_build_archetype_row())
	_build_skill_section()


func _build_archetype_row() -> HBoxContainer:
	var row := HBoxContainer.new()
	row.add_theme_constant_override("separation", 16)

	var label := Label.new()
	label.text = "Special die"
	label.custom_minimum_size.x = 130
	label.add_theme_font_size_override("font_size", 20)
	label.vertical_alignment = VERTICAL_ALIGNMENT_CENTER
	row.add_child(label)

	var options := OptionRow.create(Dice.ARCHETYPE_NAMES, _archetype, 16)
	options.option_pressed.connect(func(index: int) -> void: _archetype = index)
	row.add_child(options)
	return row


func _rank_labels() -> Array:
	var labels: Array = []
	for rank in range(Dice.MIN_RANK, Dice.MAX_RANK + 1):
		labels.append("%s
%d" % [Dice.rank_name(rank), rank])
	return labels


## At most one skill applies to a check, so this is an add/remove pair rather
## than a list.
func _build_skill_section() -> void:
	var box := VBoxContainer.new()
	box.add_theme_constant_override("separation", 12)

	var header := HBoxContainer.new()
	header.add_theme_constant_override("separation", 16)

	var label := Label.new()
	label.text = "Skill"
	label.custom_minimum_size.x = 130
	label.add_theme_font_size_override("font_size", 20)
	label.vertical_alignment = VERTICAL_ALIGNMENT_CENTER
	header.add_child(label)

	var toggle := Button.new()
	toggle.text = "Remove skill" if _has_skill() else "+ Add skill"
	toggle.custom_minimum_size = Vector2(160, 40)
	toggle.add_theme_font_size_override("font_size", 16)
	UiStyles.apply_chip(toggle)
	toggle.pressed.connect(_on_skill_toggled)
	header.add_child(toggle)

	if not _has_skill():
		var hint := Label.new()
		hint.text = "optional — one per check"
		hint.modulate = Color(1, 1, 1, 0.5)
		hint.add_theme_font_size_override("font_size", 16)
		hint.vertical_alignment = VERTICAL_ALIGNMENT_CENTER
		header.add_child(hint)

	box.add_child(header)

	if _has_skill():
		var skill_row := HBoxContainer.new()
		skill_row.add_theme_constant_override("separation", 16)

		# Keeps the skill buttons aligned with the score buttons below them.
		var spacer := Control.new()
		spacer.custom_minimum_size.x = 130
		skill_row.add_child(spacer)

		var skills := OptionRow.create(Dice.SKILL_NAMES, _skill, 14)
		skills.size_flags_horizontal = Control.SIZE_EXPAND_FILL
		skills.option_pressed.connect(func(index: int) -> void: _skill = index)
		skill_row.add_child(skills)
		box.add_child(skill_row)

		var score_row := HBoxContainer.new()
		score_row.add_theme_constant_override("separation", 16)

		var score_label := Label.new()
		score_label.text = "Score"
		score_label.custom_minimum_size.x = 130
		score_label.add_theme_font_size_override("font_size", 18)
		score_label.vertical_alignment = VERTICAL_ALIGNMENT_CENTER
		score_row.add_child(score_label)

		var scores := OptionRow.create(
			_score_labels(), _skill_score - Dice.MIN_SKILL_SCORE, 16
		)
		scores.option_pressed.connect(func(index: int) -> void:
			_skill_score = index + Dice.MIN_SKILL_SCORE)
		score_row.add_child(scores)
		box.add_child(score_row)

	_content.add_child(box)


func _score_labels() -> Array:
	var labels: Array = []
	for score in range(Dice.MIN_SKILL_SCORE, Dice.MAX_SKILL_SCORE + 1):
		labels.append(str(score))
	return labels


func _has_skill() -> bool:
	return _skill != Dice.NO_SKILL


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


func _on_rank_pressed(index: int, ability: String) -> void:
	_ranks[ability] = index + Dice.MIN_RANK


func _on_skill_toggled() -> void:
	if _has_skill():
		_skill = Dice.NO_SKILL
	else:
		_skill = 0
		_skill_score = Dice.DEFAULT_SKILL_SCORE
	_refresh()


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
	wizard_completed.emit({
		"selections": selections,
		"stakes": _stakes,
		"archetype": _archetype,
		"skill": _skill,
		"skill_score": _skill_score,
	})
