import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { connect, createServer, type AddressInfo, type Socket } from "node:net";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { chromium } from "playwright-core";
import { publicHttpsCertificate, publicHttpsControl } from "./public-https-gateway-service.js";

const exec = promisify(execFile);

/** Run in the network-none worker, with only the data socket and the public CA mounted. */
export async function openIsolatedChromium(options: {
  socketPath: string;
  signal: AbortSignal;
  headless?: boolean;
  display?: string;
  pulseServer?: string;
  proxyCertificate?: string;
  viewport?: { width: number; height: number };
}) {
  const { signal } = options;
  signal.throwIfAborted();
  const hasNetwork = Object.values(networkInterfaces()).flat().some(address => address && !address.internal);
  if (hasNetwork || existsSync(publicHttpsControl)) throw new Error("public_https_worker_not_isolated");
  const home = await mkdtemp(join(tmpdir(), "vrata-chromium-"));
  const clients = new Set<Socket>();
  const proxy = createServer(client => {
    clients.add(client);
    const gateway = connect(options.socketPath);
    client.on("error", () => client.destroy());
    gateway.on("error", () => gateway.destroy());
    client.once("close", () => {
      clients.delete(client);
      gateway.destroy();
    });
    gateway.once("close", () => client.destroy());
    client.pipe(gateway).pipe(client);
  });
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  const close = async () => {
    signal.removeEventListener("abort", abort);
    proxy.close();
    for (const client of clients) client.destroy();
    try {
      await browser?.close();
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  };
  const abort = () => { void close().catch(() => {}); };

  try {
    // An explicit isolated NSS DB keeps the gateway CA out of the platform's
    // system trust store and other Chromium instances.
    const database = join(home, ".pki", "nssdb");
    await mkdir(database, { recursive: true, mode: 0o700 });
    await exec("certutil", ["-N", "--empty-password", "-d", `sql:${database}`], { signal });
    await exec("certutil", ["-A", "-d", `sql:${database}`, "-n", "Vrata isolated gateway",
      "-t", "C,,", "-i", options.proxyCertificate ?? publicHttpsCertificate], { signal });
    await new Promise<void>((resolve, reject) => {
      proxy.once("error", reject);
      proxy.listen(0, "127.0.0.1", () => {
        proxy.removeListener("error", reject);
        resolve();
      });
    });
    signal.throwIfAborted();
    signal.addEventListener("abort", abort, { once: true });
    browser = await chromium.launch({
      channel: "chromium", headless: options.headless ?? true, chromiumSandbox: true,
      proxy: { server: `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`, bypass: "<-loopback>" },
      args: ["--disable-quic", "--force-webrtc-ip-handling-policy=disable_non_proxied_udp", "--autoplay-policy=no-user-gesture-required",
        "--deny-permission-prompts",
        ...(!options.headless && options.display ? ["--kiosk"] : [])],
      env: {
        PATH: process.env.PATH, HOME: home, LANG: "C.UTF-8",
        DISPLAY: options.display, PULSE_SERVER: options.pulseServer
      },
      timeout: 10000
    });
    signal.throwIfAborted();
    const context = await browser.newContext({
      serviceWorkers: "block", acceptDownloads: false, viewport: options.viewport, permissions: []
    });
    signal.throwIfAborted();
    return { context, close };
  } catch (error) {
    await close();
    throw error;
  }
}
