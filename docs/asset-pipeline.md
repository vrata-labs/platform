# Asset Pipeline

## Scene-authoring quality

All scene tasks start with the [shared quality contract](scene-quality-contract.md)
and [task packet](scene-authoring-task-template.md). These apply to every scene
repository. Technical checks do not establish realistic appearance, constructibility,
usability or human visual acceptance.

## Current baseline

- Validation scaffold checks extension and size budget.
- Presets are defined for texture conversion and mesh compression.
- Tests cover the validator behavior.

## Intended next integrations

- Hook validation into CI as a dedicated job.
- Add real glTF validator invocation.
- Add quality-profile specific asset budgets.
