# control-plane

Admin UI for tenants, templates, rooms, scene bundles, and branded configuration.

## Scene Bundle Upload

Use the scene bundle form to either register an existing storage key or upload a `.zip` bundle directly.

- Upload requires an admin token or another actor with `scene-bundle.write`.
- The server validates `scene.json`, referenced assets, zip paths, and size budgets before metadata is created.
- Valid uploads appear in the scene bundle list and can be bound to the selected room with `Bind selected scene bundle`.
- Invalid uploads surface stable validator issue codes in the publish status.
