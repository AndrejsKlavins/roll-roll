class_name OptionRow
extends HBoxContainer

## A horizontal row of mutually exclusive buttons — used for difficulties and
## for stakes. Emits only on a real click, so setting the value in code (as the
## supporting difficulty does) never loops back.

signal option_pressed(index: int)

var _buttons: Array[Button] = []


static func create(labels: Array, selected: int, font_size: int = 16) -> OptionRow:
	var row := OptionRow.new()
	row.add_theme_constant_override("separation", 6)
	var group := ButtonGroup.new()
	for i in labels.size():
		var button := Button.new()
		button.text = str(labels[i])
		button.toggle_mode = true
		button.button_group = group
		button.button_pressed = i == selected
		button.add_theme_font_size_override("font_size", font_size)
		button.size_flags_horizontal = Control.SIZE_EXPAND_FILL
		UiStyles.apply_toggle(button)
		button.pressed.connect(row._on_button_pressed.bind(i))
		row.add_child(button)
		row._buttons.append(button)
	return row


func select(index: int) -> void:
	if index >= 0 and index < _buttons.size():
		_buttons[index].button_pressed = true


func _on_button_pressed(index: int) -> void:
	option_pressed.emit(index)
