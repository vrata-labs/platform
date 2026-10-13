import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createSocket } from "node:dgram";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);
const IMAGE = "livekit/livekit-server@sha256:6fd3b7088874c4d119160dd688798dfec852bc014786d392caad15f6f63912a3";
async function tcpPort() {
  const server = createServer(); await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>(done => server.close(() => done())); return port;
}
async function udpPort() {
  const socket = createSocket("udp4"); await new Promise<void>(done => socket.bind(0, "127.0.0.1", done));
  const port = socket.address().port; await new Promise<void>(done => socket.close(done)); return port;
}
async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>(done => {
    const deadline = setTimeout(() => child.kill("SIGKILL"), 5000);
    child.once("exit", () => { clearTimeout(deadline); done(); }); child.kill("SIGTERM");
  });
}

/** Extract the checksum-pinned installed server into an owned test directory. Native loopback RTC works on both Linux CI
 * and WSL without depending on Docker Desktop's host/bridge routing. No deployment credentials or shared services. */
export async function startLocalLiveKitFixture() {
  await mkdir(resolve("test-results"), { recursive: true });
  const root = await mkdtemp(join(resolve("test-results"), "livekit-source-"));
  let container: string | undefined, child: ChildProcess | undefined;
  let phase = "image";
  const close = async () => { if (child) await stop(child); await rm(root, { recursive: true, force: true }); };
  try {
    try { await execute("docker", ["image", "inspect", IMAGE], { timeout: 20_000 }); }
    catch { await execute("docker", ["pull", IMAGE], { timeout: 180_000 }); }
    phase = "create";
    const created = await execute("docker", ["create", "--name", `vrata-e2e-livekit-${randomUUID()}`,
      "--label", "vrata.fixture=source-grants-e2e", IMAGE], { timeout: 30_000 });
    container = created.stdout.trim();
    if (!/^[a-f0-9]{64}$/.test(container)) throw new Error("local_livekit_container_invalid");
    phase = "extract";
    await execute("docker", ["cp", `${container}:/livekit-server`, join(root, "livekit-server")], { timeout: 30_000 });
    await execute("docker", ["rm", container], { timeout: 30_000 }); container = undefined;
    phase = "config";
    const signal = await tcpPort(); let rtcTcp = await tcpPort();
    while (rtcTcp === signal) rtcTcp = await tcpPort();
    const rtcUdp = await udpPort();
    const config = join(root, "server.yaml");
    await writeFile(config, `port: ${signal}\nbind_addresses: [127.0.0.1]\nrtc:\n  tcp_port: ${rtcTcp}\n  udp_port: ${rtcUdp}\n  node_ip: 127.0.0.1\n  use_external_ip: false\n  enable_loopback_candidate: true\nkeys:\n  devkey: secret\n`);
    child = spawn(join(root, "livekit-server"), ["--config", config, "--dev"], { stdio: "ignore" });
    phase = "ready";
    let spawnFailed = false; child.on("error", () => { spawnFailed = true; });
    const httpUrl = `http://127.0.0.1:${signal}`, url = `ws://127.0.0.1:${signal}`;
    for (let attempt = 0; attempt < 100; attempt++) {
      if (spawnFailed || child.exitCode !== null || child.signalCode !== null) throw new Error("local_livekit_server_exited");
      if (await fetch(httpUrl).then(response => response.ok, () => false)) return { url, httpUrl, close };
      await new Promise(done => setTimeout(done, 100));
    }
    throw new Error("local_livekit_server_not_ready");
  } catch {
    if (container && /^[a-f0-9]{64}$/.test(container)) await execute("docker", ["rm", container], { timeout: 30_000 }).catch(() => undefined);
    await close(); throw new Error(`local_livekit_fixture_failed:${phase}`);
  }
}
