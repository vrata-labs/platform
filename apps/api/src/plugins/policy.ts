/** Server persistence policy, separate from the portable SDK's active-package quotas.
 * Every admitted version (including failed uploads and deleted tombstones) counts for the room's
 * lifetime. At 200 records new versions are rejected; deleting/unbinding does not reset history.
 * This bounds immutable manifests and in-memory transaction copies without discarding hash history.
 */
const bindingMetadataAllowanceBytes = 2 * 1024;
export const ROOM_PLUGIN_STORAGE_LIMITS = Object.freeze({
  lifetimePackagesPerRoom: 200,
  blobRequestTimeoutMs: 15_000,
  // The persistence envelope also carries package/version/hash, enabled and explicit approvals.
  // Keep a bounded 2 KiB allowance for those fields while config is independently SDK-validated
  // against configBytes. This does not change the SDK's message or VM transport budget.
  bindingEnvelopeBytes: ROOM_PLUGIN_LIMITS.configBytes + bindingMetadataAllowanceBytes
});
import { ROOM_PLUGIN_LIMITS } from "@vrata/room-plugin-sdk";
