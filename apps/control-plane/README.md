# control-plane

Admin UI for tenants, templates, rooms, scene bundles, and branded configuration.

## Room Creation

Use the room form to create a room without calling the API manually.

- `Room slug` becomes the stable `/rooms/<slug>` path and must be globally unique.
- The preview block shows the slug, generated room URL, selected template, visibility, and selected scene bundle before publishing.
- Selecting a registered scene bundle binds its current or selected version during room creation; leaving it empty uses the runtime fallback scene.
- Private rooms automatically create an invite link after the room is published.
- `Copy room URL` copies the latest created or selected room URL.

## Scene Bundle Upload

Use the scene bundle form to either register an existing storage key or upload a `.zip` bundle directly.

- Upload requires an admin token or another actor with `scene-bundle.write`.
- The server validates `scene.json`, referenced assets, zip paths, and size budgets before metadata is created.
- Valid uploads appear in the scene bundle list and can be bound to the selected room with `Bind selected scene bundle`.
- Invalid uploads surface stable validator issue codes in the publish status.
