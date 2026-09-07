class_name UiStyles
extends RefCounted

## The colours used by the widgets that are built in code. The primary buttons
## in the scene files carry the same accent as editor-visible overrides.

const ACCENT := Color(0.607843, 0.203922, 0.219608)
const ACCENT_HOVER := Color(0.729412, 0.262745, 0.278431)
const SURFACE := Color(0.176471, 0.180392, 0.211765)
const SURFACE_HOVER := Color(0.243137, 0.247059, 0.286275)
const SLOT_EMPTY := Color(0.129412, 0.133333, 0.156863)
const SLOT_FILLED := Color(0.156863, 0.164706, 0.196078)
const OUTLINE_EMPTY := Color(1, 1, 1, 0.16)
const OUTLINE_FILLED := Color(0.729412, 0.262745, 0.278431, 0.7)


static func flat(color: Color, radius: int = 8) -> StyleBoxFlat:
	var box := StyleBoxFlat.new()
	box.bg_color = color
	box.corner_radius_top_left = radius
	box.corner_radius_top_right = radius
	box.corner_radius_bottom_right = radius
	box.corner_radius_bottom_left = radius
	box.content_margin_left = 10
	box.content_margin_right = 10
	box.content_margin_top = 6
	box.content_margin_bottom = 6
	return box


static func outlined(color: Color, border: Color, radius: int = 10) -> StyleBoxFlat:
	var box := flat(color, radius)
	box.border_color = border
	box.set_border_width_all(2)
	return box


## A segmented-control look: muted when off, accent when on.
static func apply_toggle(button: Button) -> void:
	button.add_theme_stylebox_override("normal", flat(SURFACE))
	button.add_theme_stylebox_override("hover", flat(SURFACE_HOVER))
	button.add_theme_stylebox_override("pressed", flat(ACCENT))
	button.add_theme_stylebox_override("hover_pressed", flat(ACCENT_HOVER))
	button.add_theme_stylebox_override("focus", flat(Color(0, 0, 0, 0)))
	button.add_theme_color_override("font_pressed_color", Color(1, 1, 1))
	button.add_theme_color_override("font_hover_pressed_color", Color(1, 1, 1))


static func apply_chip(button: Button) -> void:
	button.add_theme_stylebox_override("normal", flat(SURFACE, 10))
	button.add_theme_stylebox_override("hover", flat(SURFACE_HOVER, 10))
	button.add_theme_stylebox_override("pressed", flat(ACCENT, 10))
	button.add_theme_stylebox_override("focus", flat(Color(0, 0, 0, 0)))


## A small square +/- button.
static func apply_stepper(button: Button) -> void:
	for state in ["normal", "hover", "pressed", "disabled"]:
		var color := SURFACE
		if state == "hover":
			color = SURFACE_HOVER
		elif state == "pressed":
			color = ACCENT
		elif state == "disabled":
			color = Color(SURFACE, 0.4)
		var box := flat(color, 6)
		box.content_margin_left = 4
		box.content_margin_right = 4
		box.content_margin_top = 2
		box.content_margin_bottom = 2
		button.add_theme_stylebox_override(state, box)
	button.add_theme_stylebox_override("focus", flat(Color(0, 0, 0, 0), 6))
	button.add_theme_color_override("font_disabled_color", Color(1, 1, 1, 0.25))


## The exertion controls, told apart from the grey skill stepper by their outline.
static func apply_exert(button: Button) -> void:
	button.add_theme_stylebox_override("normal", outlined(Color(0, 0, 0, 0), ACCENT_HOVER, 8))
	button.add_theme_stylebox_override("hover", outlined(ACCENT, ACCENT_HOVER, 8))
	button.add_theme_stylebox_override("pressed", flat(ACCENT_HOVER, 8))
	button.add_theme_stylebox_override("focus", flat(Color(0, 0, 0, 0), 8))


## A die reading. Plain text until the player is picking one to reroll.
static func apply_die(button: Button, selectable: bool) -> void:
	var blank := flat(Color(0, 0, 0, 0), 8)
	blank.content_margin_left = 4
	blank.content_margin_right = 4
	if selectable:
		button.add_theme_stylebox_override("normal", outlined(Color(0, 0, 0, 0), ACCENT_HOVER, 8))
		button.add_theme_stylebox_override("hover", outlined(ACCENT, ACCENT_HOVER, 8))
		button.add_theme_stylebox_override("pressed", flat(ACCENT_HOVER, 8))
	else:
		button.add_theme_stylebox_override("normal", blank)
		button.add_theme_stylebox_override("hover", blank)
		button.add_theme_stylebox_override("pressed", blank)
	button.add_theme_stylebox_override("disabled", blank)
	button.add_theme_stylebox_override("focus", flat(Color(0, 0, 0, 0), 8))
	button.add_theme_color_override("font_disabled_color", Color(1, 1, 1))


static func apply_slot(panel: PanelContainer, filled: bool) -> void:
	panel.add_theme_stylebox_override("panel", outlined(
		SLOT_FILLED if filled else SLOT_EMPTY,
		OUTLINE_FILLED if filled else OUTLINE_EMPTY,
	))
