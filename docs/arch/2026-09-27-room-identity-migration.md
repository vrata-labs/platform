# Room identity migration: preliminary client contract

## Delivery boundary

This is T01a-S1 of the working-meeting plan: deliver a usable update/rejoin path **before** enforcing identity v2. S1 adds no identity issuance, identity credential, publisher authority, plugin endpoint, or v2 capability advertisement. The legacy server still issues the existing sessions. Server-side identity security remains T01a-S2.

The shared contract is in `packages/shared-types/src/identity-upgrade.ts`. Future server enforcement must use these exact signals so already-open S1 clients can stop gracefully.

## Wire contract

REST responses:

```json
{"error":"identity_required","reason":"identity_upgrade_required"}
```

or:

```json
{"error":"identity_required","reason":"identity_recovery_required"}
```

- Accepted HTTP statuses: 401, 409, 426. Status alone never triggers the identity gate.
- Recommended server mapping: 426 for an incompatible client protocol, 401 for an obsolete authenticated session/epoch, 409 for identity requiring administrator recovery.
- Both the literal `error` and an allowlisted `reason` are required. Arbitrary server text is never rendered in the dialog. Ordinary access denial and revision conflicts retain existing behavior.
- Room-state accepts the WebSocket and then closes with 4406 for upgrade or 4409 for recovery. The optional close reason is either empty or exactly the matching reason literal. A rejected handshake is an opaque browser 1006 and cannot carry this contract.
- Old connection generations cannot block a newer connection. A current connection's identity close is handled before generic reconnect handling.

## Client behavior

The gate is terminal for a page lifetime and can escalate upgrade → recovery, never downgrade. It rejects new API calls and responses completing after the gate. Live session-control application and reconnect entry points also check session blocking, covering the gap between reading a response and applying its JSON.

The normal room UI presents a native modal dialog, with keyboard focus, mobile-width layout and plain-text guidance. Escape does not resume a rejected session. Upgrade offers **Update and rejoin**; recovery directs the participant to the room administrator. Recovery credential entry will arrive with its actual server endpoint in S2.

Runtime shutdown invalidates room-state callbacks, reconnect and seat-reclaim timers, pending document/note operations and media ownership. Media disconnection runs even if surface cleanup throws. The frame loop stops; an active immersive XR session is asked to end so the DOM message becomes available. The real-headset version of this exceptional transition has not been manually accepted.

The update action reloads the bundle. Static HTML is served with `Cache-Control: no-cache`. A room- and build-scoped tab marker suppresses another update button if the same build again receives an upgrade denial; the UI then asks for browser refresh/administrator help. There is no automatic reload loop.

S1 deliberately retains legacy participant IDs, personal-owner IDs, display name and device preferences. Deleting the ID before server-issued adoption would strand legacy host/private-note references. Retention does **not** prove identity: S2 must ignore an unproven caller-supplied ID, reject legacy JWT laundering and adopt the authoritative v2 response consistently across the runtime.

## Unsaved notes

- Before shutdown, dirty editor text is copied to room/scoped sessionStorage in the current tab, including an intentionally empty draft.
- At most one shared and one private draft are retained per room, each bounded by the existing 20,000-character editor limit. No credential is stored in draft records or diagnostics.
- The copy is visible as a read-only text area and can be downloaded. On reload it is shown separately; it never overwrites a server note or auto-saves under another identity.
- If storage is unavailable, the in-memory copy remains visible, and updating asks confirmation because that copy cannot survive reload. Closing the tab can lose tab-local drafts; the UI tells the participant to copy/download first.
- Scope changes settle dirty text under the original editor scope before switching. A migration denial retains that original scope. If ordinary edit permission was revoked, a local read-only draft preserves the edits while the participant can still switch to private notes. A failed load does not relabel saved content as a dirty draft for the other scope.

## Rollout and compatibility

1. Publish and verify S1 on the normal pipeline. Existing tabs loaded before S1 do not gain the dialog retroactively: ask their users to refresh while legacy entry is still available.
2. Implement and test v2 server issuance and runtime adoption together with one-time room-bound administrator recovery. Credential continuity, epoch, both refresh paths, live WS authority and all room writes require explicit tests.
3. Only then enable v2 enforcement. A legacy JWT or known participant/owner ID must never be exchanged for proven identity. Old owners without proof use the recovery process.
4. Rollback of S1 itself returns the previous client and legacy server; plugins remain unavailable. Once v2/plugin authority is enforced, do not roll back to ID-only issuance while author endpoints remain active.

## Verification scope

`tests/e2e/session-upgrade.spec.ts` runs the same three cases locally and on published staging: boot rejection/reload loop, rejection during live note editing with a delayed session-control response, and recovery close without reconnect. Future REST/WS denials are injected at the browser transport boundary because S1 does not yet enable a v2 server. These tests prove the published client behavior, **not** server identity enforcement or recovery completion.

Unit coverage includes wire allowlists, monotonic escalation, late responses, tab/room draft isolation, storage failure, failing teardown, and note cancellation/scope ownership. Existing room, notes, media, seat, avatar and scene suites remain part of the normal local/staging gate.
