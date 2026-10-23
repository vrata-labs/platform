# Room behaviors: author guide

A room behavior is an external `.vrata-plugin.json` package built with `@vrata/room-plugin-sdk` (see `packages/room-plugin-sdk/README.md` for the SDK, CLI and examples). The platform never builds, installs or trusts author code: every package runs as data inside an isolated QuickJS sandbox with no page, network, token or media access.

## Who can manage behaviors

- The current Host of the room with a proven identity-v2 session, the proven owner of a personal room, or a platform administrator through the API.
- Members, Guests and Presenters cannot upload, enable or delete packages; the server checks the current role on every request.
- On a server whose shared identity floor is still 1 the behavior routes are closed: the room UI shows no author panel and loads no sandbox.

## Room UI

Open **More tools and details → Room behaviors** in the room.

1. **Upload package** — choose a `.vrata-plugin.json` file (up to 1 MiB). Uploading stores an immutable version; it does not run anything.
2. Review the plugin name, ID, exact version, size and SHA-256 prefix, and the **permissions requested by this exact version**. Each permission starts unchecked for a first install and for every permission a newer version adds.
3. Fill the settings generated from the manifest config schema and tick the permissions you accept for this room.
4. **Enable version X** binds that exact package hash, settings and permissions. Everyone in the room sees the labelled status line within a few seconds, without reloading.

Later:

- **Switch to version X** updates or rolls back to another stored version. Permissions that version adds need a new explicit confirmation.
- **Apply settings** changes settings of the enabled version.
- **Disable** stops the behavior for everyone. People who are already seated keep their seats.
- **Remove from room** unbinds a disabled behavior; **Delete version X** removes a stored version that is not bound. A bound version cannot be deleted.

Writes are paused while the browser is offline and the list is re-read when the connection returns. A conflicting change made elsewhere shows a short message and refreshes the list instead of overwriting it.

## Limits

At most 10 stored packages and 10 MiB per room, 2 enabled behaviors at once, 1 MiB per package. A version number cannot be reused with different contents; publish a new version instead.

## API

The same operations are available as room-scoped routes with the caller's own session bearer token or the platform administrator header:

- `GET /api/rooms/:roomId/plugins/packages` — library: packages, bindings and the room plugin revision.
- `POST /api/rooms/:roomId/plugins/packages` — upload package bytes.
- `PUT /api/rooms/:roomId/plugins/bindings/:pluginId` — `expectedRevision`, exact `packageId`/`version`/`artifactSha256`, `enabled`, `config`, `approvedCapabilities` and, for new permissions, `capabilityApproval` for the same artifact hash.
- `DELETE /api/rooms/:roomId/plugins/bindings/:pluginId` — unbind with `expectedRevision`.
- `DELETE /api/rooms/:roomId/plugins/packages/:packageId` — delete an unbound version.

Identity-v2 `GET /session-control` responses carry `pluginBindingsRevision`, a change hint that lets running clients revalidate sooner. It is never authority: clients always re-read `GET /plugins/runtime` and keep the five-second binding lease.
