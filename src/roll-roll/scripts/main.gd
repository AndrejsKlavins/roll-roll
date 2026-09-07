extends Control

## Owns the screen flow: wizard -> roll screen -> back to wizard.

@onready var _wizard: Control = $WizardScreen
@onready var _roll_screen: Control = $RollScreen


func _ready() -> void:
	_wizard.wizard_completed.connect(_on_wizard_completed)
	_roll_screen.restart_requested.connect(_on_restart_requested)
	_show_wizard()


func _show_wizard() -> void:
	_wizard.visible = true
	_roll_screen.visible = false


func _on_wizard_completed(selections: Array, stakes: int) -> void:
	_roll_screen.setup(selections, stakes)
	_wizard.visible = false
	_roll_screen.visible = true


func _on_restart_requested() -> void:
	_wizard.reset()
	_show_wizard()
