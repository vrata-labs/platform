import { existsSync } from "node:fs";
import { copyFile, lstat, mkdir, rm, symlink } from "node:fs/promises";
import { createServer, connect, type Socket } from "node:net";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { isRemoteBrowserSiteIssue, type RemoteBrowserPatch, type RemoteBrowserPublicHttpsBinding, type RemoteBrowserSiteIssue } from "@vrata/shared-types";
import { connectPublicHttpsGateway } from "./public-https-gateway-client.js";
import { publicHttpsCertificate, publicHttpsControl } from "./public-https-gateway-service.js";
import { absoluteDeadline, publicHttpsPublisher, publicHttpsSlotDirectory, publicHttpsSlots, publicHttpsWorkerReady, readMessages, writeMessage } from "./public-https-channel.js";
import { PublicHttpsPublisher } from "./public-https-publisher.js";
import { PublicHttpsOpenError, type PublicHttpsRuntime } from "./public-https-sessions.js";
import { parsePublicHttpsTarget } from "./url-policy.js";

type PublisherCredentials = { token: string; livekitUrl: string };
type SlotLease = { closing?: Promise<void> };

export function createPublicHttpsRuntime(options: {
  env: NodeJS.ProcessEnv;
  requestCredentials(binding: RemoteBrowserPublicHttpsBinding, signal: AbortSignal): Promise<PublisherCredentials>;
  patch(binding: RemoteBrowserPublicHttpsBinding, patch: RemoteBrowserPatch, signal: AbortSignal): Promise<void>;
}): PublicHttpsRuntime | undefined {
  if (options.env.REMOTE_BROWSER_PUBLIC_HTTPS_ENABLED !== "true" || !existsSync(publicHttpsPublisher)
    || !existsSync("/usr/bin/ffmpeg")) return undefined;
  const occupied = new Map<number, SlotLease>();
  return {
    prepare(binding) {
      const directory = (slot: number, kind: "display" | "proxy") => `${publicHttpsSlotDirectory(slot)}-${kind}`;
      const configured = publicHttpsSlots.filter(candidate => existsSync(join(directory(candidate, "display"), "worker.sock"))
        && existsSync(directory(candidate, "proxy")));
      const slot = configured.find(candidate => !occupied.has(candidate))
        ?? configured.find(candidate => occupied.get(candidate)?.closing);
      if (!existsSync(publicHttpsControl) || !existsSync(publicHttpsCertificate)) throw new PublicHttpsOpenError("executor_unavailable");
      if (!slot) throw new PublicHttpsOpenError(occupied.size === publicHttpsSlots.length ? "session_limit_exceeded" : "executor_unavailable");
      const previous = occupied.get(slot)?.closing;
      const lease: SlotLease = {};
      occupied.set(slot, lease);
      const display = directory(slot, "display");
      const proxy = directory(slot, "proxy");
      const xSocket = `/tmp/.X11-unix/X${slot}`;
      const controller = new AbortController();
      const { signal } = controller;
      const gateway = connectPublicHttpsGateway(() => controller.abort(new PublicHttpsOpenError("executor_unavailable")));
      const capture = new PublicHttpsPublisher(() => controller.abort(new PublicHttpsOpenError("livekit_publish_failed")));
      const proxyClients = new Set<Socket>();
      const proxyServer = createServer(client => {
        if (signal.aborted || proxyClients.size >= 128) return client.destroy();
        const upstream = connect(gateway.socketPath);
        proxyClients.add(client);
        client.once("error", () => client.destroy());
        upstream.once("error", () => upstream.destroy());
        client.once("close", () => { proxyClients.delete(client); upstream.destroy(); });
        upstream.once("close", () => client.destroy());
        client.pipe(upstream).pipe(client);
      });
      let worker: Socket | undefined;
      let deadline: string;
      let opening: Promise<void> | undefined;
      let ready = false;
      let patchQueue = Promise.resolve();
      function inputEventId() { return `${binding.executorInstanceId}:public-https:${randomUUID()}`; }
      function revoke() {
        controller.abort();
        worker?.destroy();
        capture.revoke();
        proxyServer.close();
        for (const socket of proxyClients) socket.destroy();
        lease.closing = Promise.allSettled([opening, capture.finished]).then(async () => {
          await previous;
          await Promise.all([xSocket, join(proxy, "proxy.sock"), join(proxy, "ca.pem")]
            .map(path => rm(path, { force: true })));
          if (occupied.get(slot!) === lease) occupied.delete(slot!);
        });
        void lease.closing.catch(() => {}); // A failed cleanup keeps the slot unavailable.
      }
      function failOnAbort<T>(promise: Promise<T>): Promise<T> {
        if (signal.aborted) return Promise.reject(signal.reason);
        return new Promise((resolve, reject) => {
          const abort = () => reject(signal.reason);
          signal.addEventListener("abort", abort, { once: true });
          void promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
        });
      }
      async function open(url: string) {
        if (!parsePublicHttpsTarget(url)) throw new PublicHttpsOpenError("url_not_allowed");
        if (previous) await failOnAbort(previous);
        await failOnAbort(gateway.ready);
        // The previous browser must be gone before this slot exposes another
        // session's proxy, even if its capture and gateway already stopped.
        while (!existsSync(join(display, publicHttpsWorkerReady))) await delay(50, undefined, { signal });
        await rm(join(proxy, "proxy.sock"), { force: true });
        await copyFile(publicHttpsCertificate, join(proxy, "ca.pem"));
        signal.throwIfAborted();
        await new Promise<void>((resolve, reject) => {
          proxyServer.once("error", reject);
          proxyServer.listen(join(proxy, "proxy.sock"), resolve);
        });
        signal.throwIfAborted();
        const channel = worker = connect(join(display, "worker.sock"));
        await failOnAbort(new Promise<void>((resolve, reject) => {
          channel.once("close", () => {
            if (!signal.aborted) controller.abort(new PublicHttpsOpenError("executor_unavailable"));
          });
          readMessages(channel, message => {
            const data = message as { type?: unknown; scope?: unknown; issue?: unknown };
            if (data.type === "opened") {
              ready = true;
              resolve();
            } else if (data.type === "rejected" && isRemoteBrowserSiteIssue(data.issue)) {
              reject(new PublicHttpsOpenError(navigationError(data.issue)));
            } else if (data.type === "failed") {
              reject(new PublicHttpsOpenError("executor_unavailable"));
            } else if (data.type === "issue" && (data.scope === "navigation" || data.scope === "resource")
              && (data.issue === null || isRemoteBrowserSiteIssue(data.issue))) {
              const patch = { type: "mark-site-status", scope: data.scope, issue: data.issue, inputEventId: inputEventId() } as const;
              patchQueue = patchQueue.then(async () => {
                if (!signal.aborted) await options.patch(binding, patch, signal);
              }).catch(() => {});
            }
          });
          writeMessage(channel, { type: "deadline", deadline });
          writeMessage(channel, { type: "open", url });
        }));
        signal.throwIfAborted();
        const displaySocket = join(display, `X${slot}`);
        const pulseSocket = join(display, "pulse.sock");
        if (!(await lstat(displaySocket)).isSocket() || !(await lstat(pulseSocket)).isSocket()) {
          throw new PublicHttpsOpenError("viewport_capture_failed");
        }
        await mkdir("/tmp/.X11-unix", { recursive: true });
        await rm(xSocket, { force: true });
        await symlink(displaySocket, xSocket);
        await options.patch(binding, { type: "mark-publishing", mediaParticipantId: binding.executorInstanceId, inputEventId: inputEventId() }, signal);
        const credentials = await options.requestCredentials(binding, signal).catch(() => { throw new PublicHttpsOpenError("livekit_token_failed"); });
        signal.throwIfAborted();
        const tracks = await failOnAbort(capture.start({ ...credentials, display: `:${slot}`, pulseServer: `unix:${pulseSocket}` }))
          .catch(error => { throw signal.aborted ? signal.reason : new PublicHttpsOpenError("livekit_publish_failed"); });
        await options.patch(binding, { type: "mark-active", mediaParticipantId: binding.executorInstanceId,
          mediaTrackSid: tracks.videoTrackSid, audioTrackSid: tracks.audioTrackSid, inputEventId: inputEventId() }, signal);
      }
      return {
        gateway,
        publisher: {
          setDeadline(deadlineMs) {
            signal.throwIfAborted();
            deadline = absoluteDeadline(deadlineMs);
            capture.setDeadline(deadlineMs);
            if (worker && !writeMessage(worker, { type: "deadline", deadline })) throw new PublicHttpsOpenError("executor_unavailable");
          },
          revoke
        },
        open(url, authoritySignal) {
          const startupTimeout = setTimeout(() => controller.abort(new PublicHttpsOpenError("executor_timeout")), 15_000);
          opening = open(url).finally(() => clearTimeout(startupTimeout));
          // A worker, gateway, or publisher may disappear after startup. Keep
          // this lifecycle promise pending so the executor retires the binding.
          return failOnAbort(opening.then(() => new Promise<void>(() => {}))).catch(error => {
            if (authoritySignal.aborted) return;
            throw error;
          });
        },
        input(patch) {
          return !signal.aborted && ready && Boolean(worker && writeMessage(worker, { type: "input", patch }));
        }
      };
    }
  };
}

function navigationError(issue: RemoteBrowserSiteIssue) {
  return issue === "private_destination" ? "url_resolution_blocked" : issue === "room_policy" ? "url_not_allowed" : "navigation_failed";
}
