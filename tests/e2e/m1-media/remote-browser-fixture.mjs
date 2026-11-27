import { randomUUID } from "node:crypto";
import { PublicHttpsOpenError } from "../../../apps/remote-browser/dist/public-https-sessions.js";

// Inject only the browser/publisher boundary. The real services select the rule, authorize
// the exact executor, process its callbacks, and keep the old browser path operational.
process.env.VRATA_DISABLE_AUTOSTART = "1";
const { remoteBrowserExecutorCallbackBody, startRemoteBrowserService } = await import("../../../apps/remote-browser/dist/index.js");
const fixtureOrigin = "https://shared-browser.test";

const server = startRemoteBrowserService(Number(process.env.REMOTE_BROWSER_PORT), process.env, {
  prepare(binding) {
    const session = { ...binding, frameStreamId: `${binding.sessionId}:frames` };
    const callback = new URL(`/api/internal/remote-browser/sessions/${encodeURIComponent(binding.sessionId)}`,
      process.env.ROOM_STATE_INTERNAL_URL);
    async function patch(fields, signal) {
      const response = await fetch(callback, {
        method: "POST",
        headers: { "content-type": "application/json", "x-vrata-internal-token": process.env.VRATA_INTERNAL_SERVICE_TOKEN },
        body: JSON.stringify(remoteBrowserExecutorCallbackBody(session, { ...fields, inputEventId: randomUUID() })),
        signal
      });
      if (!response.ok) throw new Error(`fixture_callback_failed:${response.status}`);
    }
    return {
      gateway: { setDeadline() {}, revoke() {} },
      publisher: { setDeadline() {}, revoke() {} },
      async open(url, signal) {
        const target = new URL(url);
        if (target.origin !== fixtureOrigin) throw new PublicHttpsOpenError("url_not_allowed");
        if (target.pathname === "/restricted") throw new PublicHttpsOpenError("url_resolution_blocked");
        if (!["/control", "/resource-error"].includes(target.pathname)) throw new PublicHttpsOpenError("navigation_failed");
        await patch({ type: "mark-publishing", mediaParticipantId: binding.executorInstanceId }, signal);
        await patch({
          type: "mark-active", mediaParticipantId: binding.executorInstanceId,
          mediaTrackSid: `fixture-video:${binding.executorInstanceId}`, audioTrackSid: `fixture-audio:${binding.executorInstanceId}`
        }, signal);
        if (target.pathname === "/resource-error") {
          await patch({ type: "mark-site-status", scope: "resource", issue: "private_destination" }, signal);
        }
      }
    };
  }
});

process.on("SIGTERM", () => server.close());
