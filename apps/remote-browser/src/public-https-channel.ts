import type { Socket } from "node:net";
import { REMOTE_BROWSER_PUBLIC_HTTPS_MAX_LEASE_MS, type RemoteBrowserPatch } from "@vrata/shared-types";

export const publicHttpsSlots = [91, 92] as const;
export const publicHttpsWorkerDirectory = "/tmp/.X11-unix";
export const publicHttpsWorkerReady = "worker.ready";
export const publicHttpsSlotDirectory = (slot: number) => `/var/lib/vrata-public-https/slot-${slot}`;
export const publicHttpsWorkerProxyDirectory = "/var/lib/vrata-public-https/proxy";
export const publicHttpsPublisher = "/opt/vrata-publisher/bin/python";
export type PublicHttpsInput = Extract<RemoteBrowserPatch, { type: "pointer" | "scroll" | "keyboard" }>;

export function absoluteDeadline(deadlineMs: number): string {
  // Compose peers use the same Linux monotonic clock. Sample it first to round
  // transport and conversion time down, never extending the authorization.
  const now = process.hrtime.bigint();
  const remaining = Math.floor((deadlineMs - performance.now()) * 1_000_000);
  if (!Number.isSafeInteger(remaining) || remaining <= 0) throw new Error("public_https_lease_expired");
  return (now + BigInt(remaining)).toString();
}

export function readMessages(socket: Socket, handle: (message: unknown) => void): void {
  socket.setEncoding("utf8");
  let pending = "";
  socket.on("error", () => socket.destroy());
  socket.on("data", chunk => {
    pending += chunk;
    if (pending.length > 256 * 1024) return socket.destroy();
    for (let end = pending.indexOf("\n"); end >= 0; end = pending.indexOf("\n")) {
      try {
        handle(JSON.parse(pending.slice(0, end)));
      } catch {
        return socket.destroy();
      }
      if (socket.destroyed) return;
      pending = pending.slice(end + 1);
    }
  });
}

export function writeMessage(socket: Socket, message: object): boolean {
  if (socket.destroyed || socket.writableLength > 128 * 1024) return false;
  socket.write(`${JSON.stringify(message)}\n`);
  return true;
}

export function enforceWorkerDeadline(stop: () => void) {
  let timer: NodeJS.Timeout | undefined;
  let current = process.hrtime.bigint() + 2_000_000_000n;
  function expire() {
    const now = process.hrtime.bigint();
    if (now >= current) stop();
    else timer = setTimeout(expire, Math.ceil(Number(current - now) / 1_000_000));
  }
  expire();
  return {
    set(value: unknown) {
      if (typeof value !== "string" || !/^\d{1,20}$/.test(value)) {
        stop();
        return false;
      }
      const next = BigInt(value);
      const now = process.hrtime.bigint();
      if (now >= current || next <= now || next - now > BigInt(REMOTE_BROWSER_PUBLIC_HTTPS_MAX_LEASE_MS) * 1_000_000n) {
        stop();
        return false;
      }
      current = next;
      clearTimeout(timer);
      expire();
      return true;
    },
    clear() { clearTimeout(timer); }
  };
}
