class_name AbilitySlot
extends PanelContainer

## A drop target for one ability. Empty until something is dragged in; once
## filled it shows the difficulty buttons for this half of the check.

signal ability_dropped(ability: String)
signal difficulty_pressed(difficulty: int)

@onready var _title: Label = %Title
@onready var _icon: TextureRect = %Icon
@onready var _name: Label = %Name
@onready var _hint: Label = %Hint
@onready var _difficulty_holder: MarginContainer = %DifficultyHolder

var ability := ""
var difficulty := Dice.DEFAULT_DIFFICULTY

var _title_text := ""
var _difficulty_row: OptionRow


func _ready() -> void:
	_difficulty_row = OptionRow.create(_difficulty_labels(), difficulty)
	_difficulty_row.option_pressed.connect(_on_difficulty_pressed)
	_difficulty_holder.add_child(_difficulty_row)
	_refresh()


func setup(title: String, for_ability: String, for_difficulty: int) -> void:
	_title_text = title
	ability = for_ability
	difficulty = for_difficulty
	if is_node_ready():
		_difficulty_row.select(difficulty)
		_refresh()


func set_difficulty(value: int) -> void:
	difficulty = clampi(value, 0, Dice.DIFFICULTY_NAMES.size() - 1)
	_difficulty_row.select(difficulty)


func is_filled() -> bool:
	return ability != ""


func _difficulty_labels() -> Array:
	var labels: Array = []
	for i in Dice.DIFFICULTY_NAMES.size():
		labels.append("%s\n%d" % [Dice.difficulty_name(i), Dice.difficulty_target(i)])
	return labels


func _refresh() -> void:
	UiStyles.apply_slot(self, is_filled())
	_title.text = _title_text
	_hint.visible = not is_filled()
	_icon.visible = is_filled()
	_name.visible = is_filled()
	_difficulty_holder.visible = is_filled()
	if is_filled():
		_icon.texture = load(Dice.icon_path(ability))
		_name.text = ability


func _can_drop_data(_at_position: Vector2, data: Variant) -> bool:
	return data is Dictionary and data.get("type") == AbilityButton.DRAG_TYPE


func _drop_data(_at_position: Vector2, data: Variant) -> void:
	ability_dropped.emit(data["ability"])


func _on_difficulty_pressed(index: int) -> void:
	difficulty = index
	difficulty_pressed.emit(index)
