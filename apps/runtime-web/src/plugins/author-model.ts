import { ROOM_PLUGIN_LIMITS, validateRoomPluginConfig, type RoomPluginCapability, type RoomPluginConfigSchema } from "@vrata/room-plugin-sdk";
import type { RoomPluginAuthorBinding, RoomPluginAuthorFailure, RoomPluginAuthorLibrary, RoomPluginAuthorPackage,
  RoomPluginBindingWrite } from "./author-http.js";

export const ROOM_PLUGIN_CAPABILITY_LABELS: Readonly<Record<RoomPluginCapability, string>> = Object.freeze({
  "status.set": "Show a short labelled status line to people in this room",
  "seating.claimSelfOnEntry": "Try once to seat each person when they enter; people can opt out",
  "seating.cancelPendingOwnClaim": "Cancel that person's own pending automatic seat"
});

export interface RoomPluginAuthorEntry {
  pluginId: string;
  displayName: string;
  binding: RoomPluginAuthorBinding | null;
  /** Newest release first. */
  versions: readonly RoomPluginAuthorPackage[];
}
export type RoomPluginAuthorIntent =
  | { type: "enable"; pluginId: string; packageId: string; approved: readonly RoomPluginCapability[]; config: Readonly<Record<string, unknown>> }
  | { type: "disable"; pluginId: string }
  | { type: "unbind"; pluginId: string }
  | { type: "delete"; packageId: string };
export type RoomPluginAuthorRefusal = "stale" | "not-ready" | "config-invalid" | "capability-unknown" | "bound" | "enabled" | "quota";
export type RoomPluginAuthorPlan =
  | { ok: true; operation: "bind"; pluginId: string; expectedRevision: number; write: RoomPluginBindingWrite; approval: readonly RoomPluginCapability[] | null }
  | { ok: true; operation: "unbind"; pluginId: string; expectedRevision: number }
  | { ok: true; operation: "delete"; packageId: string }
  | { ok: false; reason: RoomPluginAuthorRefusal };

const release = (value: string) => value.split(".").map(Number);
function newerFirst(left: RoomPluginAuthorPackage, right: RoomPluginAuthorPackage): number {
  const a = release(left.version), b = release(right.version);
  for (let index = 0; index < 3; index++) if (a[index] !== b[index]) return b[index] - a[index];
  return 0;
}
export const roomPluginPackageUsable = (value: RoomPluginAuthorPackage) => value.state === "ready" && value.uploadSettled;
/** Settled versions can be selected: ready ones enabled, a half-deleted one deleted again. */
export const roomPluginPackageSelectable = (value: RoomPluginAuthorPackage) => value.uploadSettled && value.state !== "reserved";

export function roomPluginAuthorEntries(library: RoomPluginAuthorLibrary): RoomPluginAuthorEntry[] {
  const ids = new Set([...library.packages.map(value => value.pluginId), ...library.bindings.map(value => value.pluginId)]);
  return [...ids].sort().map(pluginId => {
    const versions = library.packages.filter(value => value.pluginId === pluginId).sort(newerFirst);
    const binding = library.bindings.find(value => value.pluginId === pluginId) ?? null;
    const named = versions.find(value => value.packageId === binding?.packageId) ?? versions[0];
    return { pluginId, displayName: named?.manifest.displayName ?? pluginId, binding, versions };
  });
}

/** The author's explicit choice for this exact package; additional capabilities start unchecked. */
export function initialRoomPluginApproval(entry: RoomPluginAuthorEntry, value: RoomPluginAuthorPackage): RoomPluginCapability[] {
  if (!entry.binding) return [];
  return value.manifest.requestedCapabilities.filter(capability => entry.binding!.approvedCapabilities.includes(capability));
}
export function initialRoomPluginConfigForm(entry: RoomPluginAuthorEntry, schema: RoomPluginConfigSchema): Record<string, string | boolean> {
  const current = entry.binding?.config ?? {};
  return Object.fromEntries(Object.entries(schema).map(([key, field]) => {
    const value = Object.hasOwn(current, key) ? current[key] : undefined;
    if (field.type === "boolean") return [key, value === true];
    return [key, value === undefined || typeof value === "boolean" ? "" : String(value)];
  }));
}
/** Form values become typed config. Empty optional fields are omitted; the SDK validator decides. */
export function readRoomPluginConfigForm(schema: RoomPluginConfigSchema, form: Readonly<Record<string, string | boolean | undefined>>): Record<string, unknown> {
  const config: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(schema)) {
    const raw = form[key];
    if (field.type === "boolean") { if (raw === true || field.required) config[key] = raw === true; continue; }
    const text = typeof raw === "string" ? field.type === "number" ? raw.trim() : raw : "";
    if (text === "") { if (field.required) config[key] = ""; continue; }
    // A non-numeric entry stays text so the SDK validator rejects it instead of coercing to NaN.
    config[key] = field.type === "number" && Number.isFinite(Number(text)) ? Number(text) : text;
  }
  return config;
}

export function planRoomPluginAuthorAction(library: RoomPluginAuthorLibrary, intent: RoomPluginAuthorIntent): RoomPluginAuthorPlan {
  const binding = (pluginId: string) => library.bindings.find(value => value.pluginId === pluginId) ?? null;
  if (intent.type === "delete") {
    const value = library.packages.find(item => item.packageId === intent.packageId);
    if (!value) return { ok: false, reason: "stale" };
    if (library.bindings.some(item => item.packageId === value.packageId)) return { ok: false, reason: "bound" };
    return { ok: true, operation: "delete", packageId: value.packageId };
  }
  const current = binding(intent.pluginId);
  if (intent.type === "unbind") {
    if (!current) return { ok: false, reason: "stale" };
    if (current.enabled) return { ok: false, reason: "enabled" };
    return { ok: true, operation: "unbind", pluginId: current.pluginId, expectedRevision: library.revision };
  }
  if (intent.type === "disable") {
    if (!current) return { ok: false, reason: "stale" };
    return { ok: true, operation: "bind", pluginId: current.pluginId, expectedRevision: library.revision, approval: null,
      write: { packageId: current.packageId, version: current.version, artifactSha256: current.artifactSha256, enabled: false,
        config: current.config, approvedCapabilities: current.approvedCapabilities } };
  }
  const value = library.packages.find(item => item.packageId === intent.packageId && item.pluginId === intent.pluginId);
  if (!value) return { ok: false, reason: "stale" };
  if (!roomPluginPackageUsable(value)) return { ok: false, reason: "not-ready" };
  const approved = [...new Set(intent.approved)];
  if (approved.some(capability => !value.manifest.requestedCapabilities.includes(capability))) return { ok: false, reason: "capability-unknown" };
  let config;
  try { config = validateRoomPluginConfig(value.manifest.configSchema, intent.config); }
  catch { return { ok: false, reason: "config-invalid" }; }
  const others = library.bindings.filter(item => item.enabled && item.pluginId !== value.pluginId).length;
  if (others >= ROOM_PLUGIN_LIMITS.enabledPluginsPerRoom) return { ok: false, reason: "quota" };
  // Always explicit: the author has just confirmed these capabilities for this exact artifact hash.
  return { ok: true, operation: "bind", pluginId: value.pluginId, expectedRevision: library.revision, approval: approved,
    write: { packageId: value.packageId, version: value.version, artifactSha256: value.artifactSha256, enabled: true, config, approvedCapabilities: approved } };
}

export function roomPluginAuthorMessage(reason: RoomPluginAuthorFailure | RoomPluginAuthorRefusal): string {
  switch (reason) {
    case "stale": case "conflict": return "Room behaviors changed meanwhile. The list was refreshed; check it and try again.";
    case "not-ready": case "pending": return "This package is still being stored. Try again in a moment.";
    case "config-invalid": return "Check the settings: a required value is missing or out of range.";
    case "capability-unknown": return "This version does not request one of the selected permissions.";
    case "approval-required": return "Confirm the permissions requested by this exact version before enabling it.";
    case "bound": return "This version is used by the room. Disable and remove the behavior before deleting it.";
    case "enabled": return "Disable this behavior before removing it from the room.";
    case "quota": return "This room already uses the maximum number of packages or enabled behaviors.";
    case "invalid-package": return "This file is not a valid Vrata room plugin package.";
    case "version-conflict": return "This plugin version was already uploaded with different contents. Publish a new version number.";
    case "version-deleted": return "This version was deleted from the room. Publish a new version number instead.";
    case "too-large": return "The package is larger than 1 MiB.";
    case "session": return "Your room session must be renewed. Reload the room and try again.";
    case "forbidden": return "Only the current room host can manage room behaviors.";
    case "unsupported": return "Room behaviors are not enabled on this server yet.";
    case "unavailable": return "Room behaviors are unavailable right now. Check the connection and try again.";
  }
}
