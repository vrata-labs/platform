import { randomBytes } from "node:crypto";
import { connect } from "node:net";
import { publicHttpsControl, publicHttpsProxySocket } from "./public-https-gateway-service.js";
import type { PublicHttpsLeaseConsumer } from "./public-https-sessions.js";
import { absoluteDeadline } from "./public-https-channel.js";

export function connectPublicHttpsGateway(onClose?: () => void): PublicHttpsLeaseConsumer & { ready: Promise<void>; socketPath: string } {
  const id = randomBytes(16).toString("hex");
  const control = connect(publicHttpsControl);
  control.write(`${id}\n`);
  const ready = new Promise<void>((resolve, reject) => {
    let pending = "";
    control.setEncoding("utf8");
    control.on("data", chunk => {
      pending += chunk;
      if (pending === "ready\n") resolve();
      else if (!"ready\n".startsWith(pending)) control.destroy();
    });
    control.on("error", () => control.destroy());
    control.once("close", () => reject(new Error("public_https_gateway_closed")));
  });
  if (onClose) control.once("close", onClose);
  // The caller installs the deadline synchronously and awaits readiness before
  // launching the browser. A failed socket can close before that await.
  void ready.catch(() => {});
  return {
    ready,
    socketPath: publicHttpsProxySocket(id),
    setDeadline(deadlineMs) {
      // The Compose peers share the Linux monotonic clock/time namespace. Take
      // the hrtime sample first, so conversion and transport never extend a grant.
      if (control.destroyed) throw new Error("public_https_gateway_closed");
      control.write(`${absoluteDeadline(deadlineMs)}\n`);
    },
    revoke() {
      control.destroy();
    }
  };
}
