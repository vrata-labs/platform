# asset-pipeline

Validation and optimization tooling for web/XR content.

Scene Bundle validation accepts an optional `templateContract` and exact
`sceneVersion`. This adds required surface, aspect-ratio, and seat-policy checks
without imposing template aspect ratios on legacy bundles. Optional media
surface pixel dimensions must be provided as a bounded integer pair; physical
dimensions remain independent unless a template contract defines an aspect
ratio requirement.
