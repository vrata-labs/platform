import { assertActorSession } from "../identity/authority.js";
import type { RoomEffectActor, RoomEffectGuard } from "../identity/effect-write-guard.js";
import type { RoomRecord } from "../storage-contracts.js";
import { RoomPluginAccessError, type RoomPluginAuthorActor, type RoomPluginSessionActor } from "./access-contracts.js";

export function assertPluginIdentityFloor(minimum: number): void {
  if (!Number.isSafeInteger(minimum) || minimum < 2) throw new RoomPluginAccessError("plugin_identity_not_active");
}

export function pluginSessionGuard(actor: RoomPluginSessionActor): RoomEffectGuard {
  if (actor?.actorType !== "room-session" || !actor.proof) throw new RoomPluginAccessError("plugin_identity_not_active");
  return { ...actor.proof, expiresAtSeconds: actor.expiresAtSeconds, permission: "room.join" };
}

export function assertPluginAuthor(current: RoomEffectActor, roomType: RoomRecord["roomType"]): void {
  if (current.role !== "host" && !(roomType === "personal" && current.isOwner)) {
    throw new RoomPluginAccessError("plugin_author_forbidden");
  }
}

export function assertPluginClock(actor: RoomPluginAuthorActor | undefined, now: () => number): void {
  if (actor?.actorType === "room-session") assertActorSession(actor, now());
}
