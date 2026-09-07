class_name AbilityButton
extends Button

## One of the seven abilities, shown as an icon above its name and dragged
## into a slot on the check step.

const DRAG_TYPE := "ability"

var ability := ""


static func create(for_ability: String) -> AbilityButton:
	var button := AbilityButton.new()
	button.ability = for_ability
	button.text = for_ability
	button.icon = load(Dice.icon_path(for_ability))
	button.icon_alignment = HORIZONTAL_ALIGNMENT_CENTER
	button.vertical_icon_alignment = VERTICAL_ALIGNMENT_TOP
	button.custom_minimum_size = Vector2(112, 92)
	button.add_theme_font_size_override("font_size", 15)
	button.tooltip_text = "Drag %s onto a slot" % for_ability
	UiStyles.apply_chip(button)
	return button


func _get_drag_data(_at_position: Vector2) -> Variant:
	set_drag_preview(_make_preview())
	return {"type": DRAG_TYPE, "ability": ability}


func _make_preview() -> Control:
	var preview := PanelContainer.new()
	preview.modulate = Color(1, 1, 1, 0.85)

	var box := HBoxContainer.new()
	box.add_theme_constant_override("separation", 8)
	preview.add_child(box)

	var image := TextureRect.new()
	image.texture = icon
	image.stretch_mode = TextureRect.STRETCH_KEEP_CENTERED
	box.add_child(image)

	var label := Label.new()
	label.text = ability
	label.vertical_alignment = VERTICAL_ALIGNMENT_CENTER
	label.add_theme_font_size_override("font_size", 18)
	box.add_child(label)

	return preview
