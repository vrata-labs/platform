export const ROOM_PLUGIN_SCHEMA_VERSION = 1 as const;
export const ROOM_PLUGIN_SDK_API_VERSION = 1 as const;

export const ROOM_PLUGIN_CAPABILITIES = Object.freeze([
  "seating.claimSelfOnEntry",
  "seating.cancelPendingOwnClaim",
  "status.set"
] as const);

export type RoomPluginCapability = (typeof ROOM_PLUGIN_CAPABILITIES)[number];

/** Resource policy; enforcement belongs to storage, the VM supervisor and broker. */
export const ROOM_PLUGIN_LIMITS = Object.freeze({
  artifactBytes: 1024 * 1024,
  configBytes: 16 * 1024,
  messageBytes: 16 * 1024,
  dataDepth: 8,
  packagesPerRoom: 10,
  enabledPluginsPerRoom: 2,
  roomArtifactBytes: 10 * 1024 * 1024,
  vmHeapBytes: 16 * 1024 * 1024,
  vmStackBytes: 32 * 1024,
  wasmMaxMemoryBytes: 48 * 1024 * 1024,
  handlerBudgetMs: 50,
  workerResponseDeadlineMs: 500,
  executionMsPerSecond: 100,
  executionMsPerMinute: 2000,
  timerMinIntervalMs: 250,
  timersPerInstance: 4,
  requestsPerSecond: 10,
  requestQueueSize: 32,
  seatClaimsInFlight: 1,
  bindingLeaseMs: 5000,
  configFields: 32,
  configStringBytes: 4096,
  enumValues: 32,
  enumValueBytes: 256,
  statusTextBytes: 512,
  statusUpdatesPerSecond: 2,
  identifierBytes: 128
});

interface ConfigFieldBase { required: boolean }
export interface RoomPluginStringField extends ConfigFieldBase {
  type: "string";
  /** UTF-8 byte limits, not JavaScript string.length. */
  minLength: number;
  maxLength: number;
}
export interface RoomPluginNumberField extends ConfigFieldBase {
  type: "number";
  minimum: number;
  maximum: number;
}
export interface RoomPluginBooleanField extends ConfigFieldBase { type: "boolean" }
export interface RoomPluginEnumField extends ConfigFieldBase {
  type: "enum";
  values: readonly string[];
}
export type RoomPluginConfigField = RoomPluginStringField | RoomPluginNumberField | RoomPluginBooleanField | RoomPluginEnumField;
export type RoomPluginConfigSchema = Readonly<Record<string, RoomPluginConfigField>>;
export type RoomPluginConfig = Readonly<Record<string, string | number | boolean>>;

export interface RoomPluginManifest {
  schemaVersion: typeof ROOM_PLUGIN_SCHEMA_VERSION;
  sdkApiVersion: typeof ROOM_PLUGIN_SDK_API_VERSION;
  id: string;
  /** v1 accepts release versions MAJOR.MINOR.PATCH only. */
  version: string;
  displayName: string;
  requestedCapabilities: readonly RoomPluginCapability[];
  configSchema: RoomPluginConfigSchema;
  /** Lowercase hex SHA-256 of the UTF-8 bytes of decoded entry, without normalization. */
  entrySha256: string;
}
export interface RoomPluginArtifact {
  manifest: RoomPluginManifest;
  /** Exactly one bundled ECMAScript module. Never a URL or path. */
  entry: string;
}

/** Host-only state. Never copy credentials, room identity or this object into the VM. */
export interface RoomPluginInstanceIdentity {
  bindingId: string;
  /** Host-assigned nonnegative safe integer; never supplied by a plugin request. */
  generation: number;
  /** Host-assigned nonnegative safe integer from authoritative binding state. */
  bindingRevision: number;
}
export interface RoomPluginBinding extends RoomPluginInstanceIdentity {
  pluginId: string;
  version: string;
  artifactSha256: string;
  enabled: boolean;
  approvedCapabilities: readonly RoomPluginCapability[];
  config: RoomPluginConfig;
}
/** Additive compatibility: old session-control responses may omit this field. */
export interface RoomPluginSessionControlFields { pluginBindingsRevision?: number }

export interface RoomPluginSeatSnapshot {
  id: string;
  yaw: number;
  /** Binding-scoped pseudonym, never the platform participantId. */
  occupantAlias: string | null;
}
export interface RoomPluginRoomSnapshot {
  ownParticipantAlias: string;
  arrivalAllowed: boolean;
  seats: readonly RoomPluginSeatSnapshot[];
}
export type RoomPluginDisposeReason = "disabled" | "updated" | "session-ended" | "lease-expired";
export type RoomPluginEvent =
  | { sdkApiVersion: 1; type: "room.ready"; snapshot: RoomPluginRoomSnapshot }
  | { sdkApiVersion: 1; type: "room.connection"; state: "connected" | "reconnecting" | "disconnected" }
  | { sdkApiVersion: 1; type: "seating.snapshot"; snapshot: RoomPluginRoomSnapshot }
  | { sdkApiVersion: 1; type: "lifecycle.dispose"; reason: RoomPluginDisposeReason };

export type RoomPluginRequest =
  | { sdkApiVersion: 1; requestId: string; operation: "seating.claimSelfOnEntry"; payload: { seatId: string } }
  | { sdkApiVersion: 1; requestId: string; operation: "seating.cancelPendingOwnClaim"; payload: Record<string, never> }
  | { sdkApiVersion: 1; requestId: string; operation: "status.set"; payload: { text: string } };

export const ROOM_PLUGIN_BROKER_ERROR_CODES = Object.freeze([
  "capability-denied", "stale-generation", "lease-expired", "arrival-not-allowed",
  "seat-busy", "cancelled", "offline", "quota-exceeded", "plugin-failed"
] as const);
export type RoomPluginBrokerErrorCode = (typeof ROOM_PLUGIN_BROKER_ERROR_CODES)[number];
export type RoomPluginSeatClaimResult = "accepted" | "busy" | "cancelled" | "offline";
export type RoomPluginResponse =
  | { sdkApiVersion: 1; requestId: string; ok: true; result: RoomPluginSeatClaimResult | null }
  | { sdkApiVersion: 1; requestId: string; ok: false; error: RoomPluginBrokerErrorCode };

/** VM bridge facade: all operations are serialized, capability-checked broker requests. */
export interface RoomPluginApi {
  seating: {
    claimSelfOnEntry(seatId: string): Promise<RoomPluginSeatClaimResult>;
    cancelPendingOwnClaim(): Promise<void>;
  };
  status: { set(text: string): Promise<void> };
}
export interface RoomPluginContext { config: RoomPluginConfig; sdk: RoomPluginApi }
export interface RoomPluginModule {
  init?(context: RoomPluginContext): void | Promise<void>;
  onEvent?(event: RoomPluginEvent, context: RoomPluginContext): void | Promise<void>;
  dispose?(context: RoomPluginContext): void | Promise<void>;
}
