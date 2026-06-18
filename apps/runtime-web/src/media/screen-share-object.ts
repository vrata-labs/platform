import type { ScreenShareErrorCode } from "@vrata/shared-types";

import { classifyScreenShareError } from "../runtime-errors.js";

export function getScreenShareErrorCode(error: unknown): ScreenShareErrorCode {
  const issue = classifyScreenShareError(error);
  if (issue.code === "screen_share_unsupported") {
    return "display_capture_unsupported";
  }
  if (issue.code === "screen_share_denied") {
    return "display_capture_denied";
  }
  if (issue.code === "media_network_blocked") {
    return "media_network_blocked";
  }
  return "display_capture_failed";
}
