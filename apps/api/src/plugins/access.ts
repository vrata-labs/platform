import { validateRoomPluginArtifact } from "@vrata/room-plugin-sdk/artifact";
import { RoomPluginAccessError, type RoomPluginAccessFactory, type RoomPluginAuthorActor, type RoomPluginCleanupTicket,
  type RoomPluginContentTicket, type RoomPluginSessionActor, type RoomPluginUploadTicket } from "./access-contracts.js";
import { RoomPluginStorageError, type RoomPluginPackage, type RoomPluginRepository, type RoomPluginScope,
  type RoomPluginTransaction, type StoredRoomPluginBinding } from "./contracts.js";
import { pluginSessionGuard } from "./access-policy.js";
import { createRoomPluginStorage, roomPluginPrefix } from "./storage.js";

interface Upload { scope: RoomPluginScope; package: RoomPluginPackage; owner: object; disposition: RoomPluginUploadTicket["disposition"]; outcome?: "acked" | "rejected" }
interface Cleanup { scope: RoomPluginScope; package: RoomPluginPackage }
interface Content extends Cleanup { owner: object; binding: StoredRoomPluginBinding; revision: number }

function invalidTicket(): never { throw new RoomPluginAccessError("plugin_ticket_invalid"); }
const open = (tx: RoomPluginTransaction) => { if (tx.state.deleting) throw new RoomPluginStorageError("room_plugin_cleanup_pending"); };
const check = (tx: RoomPluginTransaction) => tx.checkAccess?.();
function release<T>(tx: RoomPluginTransaction, send: (value: T) => undefined, value: T): void {
  if (typeof send !== "function" || send.constructor.name === "AsyncFunction") throw new Error("plugin_release_callback_not_synchronous");
  check(tx);
  if (send(value) !== undefined) throw new Error("plugin_release_callback_not_synchronous");
}
function samePackage(current: RoomPluginPackage, admitted: RoomPluginPackage): boolean {
  return current.tenantId === admitted.tenantId && current.roomId === admitted.roomId && current.packageId === admitted.packageId
    && current.pluginId === admitted.pluginId && current.version === admitted.version && current.artifactSha256 === admitted.artifactSha256
    && current.storageKey === admitted.storageKey && current.backendFingerprint === admitted.backendFingerprint && current.byteLength === admitted.byteLength;
}
async function ticketPackage(tx: RoomPluginTransaction, admitted: RoomPluginPackage): Promise<RoomPluginPackage> {
  const current = await tx.getPackage(admitted.packageId);
  if (!current || !samePackage(current, admitted)) invalidTicket();
  return current;
}
function bound(binding: StoredRoomPluginBinding, value: RoomPluginPackage | null): value is RoomPluginPackage {
  return binding.enabled && value !== null && value.state === "ready" && value.uploadSettled
    && binding.tenantId === value.tenantId && binding.roomId === value.roomId && binding.packageId === value.packageId
    && binding.pluginId === value.pluginId && binding.version === value.version && binding.artifactSha256 === value.artifactSha256;
}
function sameBinding(current: StoredRoomPluginBinding, admitted: StoredRoomPluginBinding): boolean {
  return current.bindingId === admitted.bindingId && current.generation === admitted.generation && current.bindingRevision === admitted.bindingRevision
    && current.packageId === admitted.packageId && current.pluginId === admitted.pluginId && current.version === admitted.version
    && current.artifactSha256 === admitted.artifactSha256;
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object") { for (const item of Object.values(value)) freeze(item); Object.freeze(value); }
  return value;
}
/** Non-enumerable server-only members prevent accidental JSON DTO serialization. Identity is checked by WeakMap, not these members. */
function opaque<T>(members: object): T {
  const ticket = Object.create(null);
  for (const [key, value] of Object.entries(members)) Object.defineProperty(ticket, key, { value: freeze(structuredClone(value)) });
  return Object.freeze(ticket) as T;
}

export function createRoomPluginAccess(repository: RoomPluginRepository, now = Date.now): RoomPluginAccessFactory {
  const uploads = new WeakMap<object, Upload>();
  const cleanups = new WeakMap<object, Cleanup>();
  const contents = new WeakMap<object, Content>();
  const cleanupTicket = (value: RoomPluginPackage): RoomPluginCleanupTicket => {
    const ticket = opaque<RoomPluginCleanupTicket>({ package: value });
    cleanups.set(ticket, { scope: { tenantId: value.tenantId, roomId: value.roomId }, package: structuredClone(value) });
    return ticket;
  };
  const upload = (ticket: RoomPluginUploadTicket, owner?: object): Upload => {
    const value = uploads.get(ticket);
    if (!value || owner && value.owner !== owner) invalidTicket();
    return value;
  };
  const continuation = <T>(value: Cleanup, operation: (tx: RoomPluginTransaction) => Promise<T>) =>
    repository.transaction(value.scope, operation, { access: {} });
  // Reuse T04 reducers on the already-held transaction. This facade never escapes and never calls the pool again.
  const metadata = (tx: RoomPluginTransaction) => createRoomPluginStorage({ transaction: (_scope, operation) => operation(tx) }, { resumeSettledUploads: true });
  const actorScope = (actor: RoomPluginAuthorActor): RoomPluginScope => {
    if (actor?.actorType !== "room-session" && actor?.actorType !== "administrator") throw new RoomPluginAccessError("plugin_author_forbidden");
    if (actor.actorType === "room-session") pluginSessionGuard(actor);
    const scope = actor.actorType === "room-session" ? actor.proof : actor.scope;
    const owned = { tenantId: scope.tenantId, roomId: scope.roomId };
    roomPluginPrefix(owned);
    return owned;
  };
  return {
    author(original) {
      const actor = structuredClone(original), scope = actorScope(actor), owner = {};
      const transact = <T>(operation: (tx: RoomPluginTransaction) => Promise<T>, readOnly = false) =>
        repository.transaction(scope, async tx => { open(tx); return operation(tx); }, { readOnly, access: { actor, author: true } });
      return {
        authorize: () => transact(async () => undefined, true),
        async reservePackage(bytes, fingerprint) {
          const result = await transact(tx => metadata(tx).reservePackage(scope, bytes, fingerprint));
          const disposition = result.created ? "write" : result.package.state === "ready" ? "ready" : "resume";
          const ticket = opaque<RoomPluginUploadTicket>({ package: result.package, disposition });
          uploads.set(ticket, { scope, package: structuredClone(result.package), owner, disposition });
          return ticket;
        },
        async publishPackage(ticket) {
          const admitted = upload(ticket, owner);
          return transact(async tx => {
            const current = await ticketPackage(tx, admitted.package);
            if (current.state !== "ready" && current.state !== "reserved") throw new RoomPluginStorageError("plugin_invalid_transition");
            return metadata(tx).publishPackage(scope, current.packageId);
          });
        },
        putBinding: (pluginId, input, expected) => transact(tx => metadata(tx).putBinding(scope, pluginId, input, expected)),
        removeBinding: (pluginId, expected) => transact(tx => metadata(tx).removeBinding(scope, pluginId, expected)),
        async beginPackageDeletion(packageId) {
          const value = await transact(tx => metadata(tx).beginPackageDeletion(scope, packageId));
          return cleanupTicket(value);
        },
        releaseLibrary: send => transact(async tx => {
          const packages = await tx.listPackages(), bindings = await tx.listBindings();
          release(tx, send, { revision: tx.state.revision, packages, bindings });
        }, true)
      };
    },
    runtime(original) {
      // Administrator tokens do not become room runtime credentials, even if a JS caller bypasses the type.
      pluginSessionGuard(original);
      const actor: RoomPluginSessionActor = structuredClone(original), scope = actorScope(actor), owner = {};
      const transact = <T>(operation: (tx: RoomPluginTransaction) => Promise<T>) =>
        repository.transaction(scope, async tx => { open(tx); return operation(tx); }, { readOnly: true, access: { actor } });
      return {
        releaseSnapshot: send => transact(async tx => {
          const bindings: StoredRoomPluginBinding[] = [];
          for (const binding of await tx.listBindings()) if (bound(binding, await tx.getPackage(binding.packageId))) bindings.push(binding);
          check(tx);
          const leaseExpiresAtMs = Math.min(now() + 5000, actor.expiresAtSeconds * 1000);
          release(tx, send, { revision: tx.state.revision, bindings, leaseExpiresAtMs });
        }),
        async prepareBoundContent(packageId) {
          const admitted = await transact(async tx => {
            const value = await tx.getPackage(packageId);
            const binding = (await tx.listBindings()).find(binding => binding.packageId === packageId && bound(binding, value));
            if (!binding || !value) throw new RoomPluginAccessError("plugin_content_not_bound");
            return { package: value, binding, revision: tx.state.revision };
          });
          const ticket = opaque<RoomPluginContentTicket>(admitted);
          contents.set(ticket, { ...structuredClone(admitted), scope, owner });
          return ticket;
        },
        async releaseBoundContent(ticket, originalBytes, send) {
          const admitted = contents.get(ticket);
          if (!admitted || admitted.owner !== owner) invalidTicket();
          // Validation and the independent copy are outside the parent fence; original buffers never reach send.
          const bytes = new Uint8Array(originalBytes);
          const validated = validateRoomPluginArtifact(bytes, admitted.package.artifactSha256);
          if (validated.byteLength !== admitted.package.byteLength) throw new RoomPluginAccessError("plugin_binding_changed");
          await transact(async tx => {
            const value = await tx.getPackage(admitted.package.packageId);
            const binding = await tx.getBinding(admitted.binding.pluginId);
            if (tx.state.revision !== admitted.revision || !binding || !bound(binding, value)
              || !sameBinding(binding, admitted.binding) || !samePackage(value, admitted.package)) {
              throw new RoomPluginAccessError("plugin_binding_changed");
            }
            release(tx, send, bytes);
          });
        }
      };
    },
    continuation: {
      async settleUpload(ticket, outcome) {
        const admitted = upload(ticket);
        if (admitted.disposition !== "write" || !["acked", "rejected"].includes(outcome)
          || admitted.outcome && admitted.outcome !== outcome) invalidTicket();
        // The caller asserts the original writer's known terminal result, not blob existence or elapsed time.
        admitted.outcome = outcome;
        const value = await continuation(admitted, async tx => {
          const current = await ticketPackage(tx, admitted.package);
          if (current.state === "reserved") {
            if (!current.uploadSettled) await tx.setUploadSettled(current.packageId);
            if (outcome === "rejected" || tx.state.deleting) {
              await tx.setPackageState(current.packageId, "cleanup-pending");
              return { ...current, state: "cleanup-pending" as const, uploadSettled: true };
            }
            return null;
          }
          return current.state === "cleanup-pending" && current.uploadSettled ? current : null;
        });
        return value ? cleanupTicket(value) : null;
      },
      async abandonUnpublished(ticket) {
        const admitted = upload(ticket);
        const value = await continuation(admitted, async tx => {
          const current = await ticketPackage(tx, admitted.package);
          // A concurrent authorized resume may have published: never compensate a now-ready artifact.
          if (current.state === "ready" || current.state === "deleted") return null;
          if (!current.uploadSettled) throw new RoomPluginStorageError("plugin_upload_pending");
          if (current.state === "reserved") await tx.setPackageState(current.packageId, "cleanup-pending");
          return { ...current, state: "cleanup-pending" as const };
        });
        return value ? cleanupTicket(value) : null;
      },
      async confirmDeletion(ticket) {
        const admitted = cleanups.get(ticket);
        if (!admitted) invalidTicket();
        await continuation(admitted, async tx => {
          await ticketPackage(tx, admitted.package);
          await metadata(tx).confirmPackageDeletion(admitted.scope, admitted.package.packageId);
        });
      }
    }
  };
}
