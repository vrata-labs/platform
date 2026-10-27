import type { ServerResponse } from "node:http";
import { uncertainRoomCommit } from "./identity/fence-transaction.js";

export type FencedAuditResult = "allowed" | "denied" | "uncertain" | "failed" | "not_found";

/** Exactly one audit record for a v2 room request: the fenced outcome when one is known (allowed once the response
 * was released or the effect committed, denied when the fence refused it, uncertain when COMMIT's outcome is
 * unknown), an explicit denial, or else — settled when the handler has finished — what the response ended with.
 * Entry-time authorization is not an outcome. */
export function createFencedAudit(write: (result: FencedAuditResult, reason?: string) => void, deniedReason: (error: unknown) => string | null) {
  let recorded = false;
  const record = (result: FencedAuditResult, reason?: string) => {
    if (recorded) return;
    recorded = true;
    write(result, reason);
  };
  const audit = {
    released() { record("allowed"); },
    denied(reason: string) { record("denied", reason); },
    refused(error: unknown) {
      const reason = deniedReason(error) ?? undefined;
      record(uncertainRoomCommit(error) ? "uncertain" : reason ? "denied" : "failed", reason);
    },
    async effect<T>(run: () => Promise<T>): Promise<T> {
      try {
        const result = await run();
        audit.released();
        return result;
      } catch (error) { audit.refused(error); throw error; }
    },
    /** Call once the handler has finished: a request without a fenced outcome is recorded by its response. */
    settle(response: ServerResponse) {
      if (!response.headersSent) return record("failed", "no_response");
      const status = response.statusCode;
      record(status < 400 ? "allowed" : status === 404 ? "not_found" : [401, 403, 409, 426].includes(status) ? "denied" : "failed",
        `http_${status}`);
    }
  };
  return audit;
}

export type FencedAudit = ReturnType<typeof createFencedAudit>;
