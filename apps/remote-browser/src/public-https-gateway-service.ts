import { chmod, rm } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createBrowserCertificateAuthority } from "./public-https-certificates.js";
import { PublicHttpsGateway } from "./public-https-gateway.js";
import { createPublicHttpsAddressPolicy, createPublicHttpsResolver } from "./url-policy.js";

export const publicHttpsDataDirectory = "/var/lib/vrata-public-https/data";
export const publicHttpsControl = "/var/lib/vrata-public-https/control/gateway.sock";
export const publicHttpsCertificate = join(publicHttpsDataDirectory, "ca.pem");

export function publicHttpsProxySocket(id: string): string {
  if (!/^[a-f0-9]{32}$/.test(id)) throw new Error("invalid_public_https_handle");
  return join(publicHttpsDataDirectory, `${id}.sock`);
}

async function start(): Promise<void> {
  const denied = process.env.REMOTE_BROWSER_PUBLIC_HTTPS_DENY_CIDRS?.trim();
  if (!denied) throw new Error("public_https_deployment_cidrs_required");
  const resolve = createPublicHttpsResolver(createPublicHttpsAddressPolicy(denied.split(",").map(cidr => cidr.trim())));
  const certificates = await createBrowserCertificateAuthority(publicHttpsCertificate);
  await rm(publicHttpsControl, { force: true });
  const sessions = new Map<string, Socket>();
  const control = createServer(socket => {
    socket.setEncoding("utf8");
    socket.on("error", () => socket.destroy());
    socket.setTimeout(3000, () => socket.destroy());
    let pending = "";
    let gateway: PublicHttpsGateway | undefined;
    let listening = false;
    let granted = false;
    let ready = false;
    const sendReady = () => {
      if (!ready && listening && granted) {
        ready = true;
        socket.setTimeout(0);
        socket.write("ready\n");
      }
    };
    socket.on("data", chunk => {
      pending += chunk;
      if (pending.length > 1024) return socket.destroy();
      for (let end = pending.indexOf("\n"); end >= 0; end = pending.indexOf("\n")) {
        const line = pending.slice(0, end);
        pending = pending.slice(end + 1);
        if (!gateway) {
          if (!/^[a-f0-9]{32}$/.test(line) || sessions.has(line) || sessions.size >= 16) return socket.destroy();
          const path = publicHttpsProxySocket(line);
          const lease = new PublicHttpsGateway({ certificate: certificates.forHost, resolve });
          gateway = lease;
          sessions.set(line, socket);
          socket.once("close", () => {
            lease.revoke();
            sessions.delete(line);
          });
          lease.signal.addEventListener("abort", () => socket.destroy(), { once: true });
          lease.proxy.once("error", () => lease.revoke());
          lease.proxy.listen(path, () => {
            void chmod(path, 0o660).then(() => {
              listening = true;
              sendReady();
            }).catch(() => lease.revoke());
          });
        } else {
          if (!/^\d{1,20}$/.test(line) || !gateway.setDeadline(BigInt(line))) return socket.destroy();
          granted = true;
          sendReady();
        }
      }
    });
  });
  control.listen(publicHttpsControl, () => {
    void chmod(publicHttpsControl, 0o660).catch(failStartup);
  });
  control.once("error", failStartup);
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
  function shutdown() {
    for (const socket of sessions.values()) socket.destroy();
    control.close();
    void certificates.close().finally(() => process.exit());
  }
  function failStartup() {
    console.error("public_https_gateway_control_failed");
    process.exitCode = 1;
    shutdown();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void start().catch(() => {
    console.error("public_https_gateway_start_failed");
    process.exitCode = 1;
  });
}
