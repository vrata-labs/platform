import { referenceTemplateContract } from "@vrata/templates";
import type { RemoteBrowserUrlPolicy, RoomRecord } from "./storage-contracts.js";

export function isRemoteBrowserUrlPolicy(value: unknown): value is RemoteBrowserUrlPolicy {
  return value === "allowlist" || value === "public-https";
}

export function roomSupportsRemoteBrowserUrlPolicy(
  room: Pick<RoomRecord, "visibility" | "managed" | "templateSnapshot">,
  visibility = room.visibility
): boolean {
  return visibility === "private"
    && (room.managed ? room.managed.kind === "custom" : !referenceTemplateContract(room.templateSnapshot));
}
