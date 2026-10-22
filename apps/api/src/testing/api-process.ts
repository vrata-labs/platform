import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function reservePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address !== "object") throw new Error("port_reservation_failed");
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

export interface ApiProcess {
  baseUrl: string;
  logs(): string;
  stop(): Promise<void>;
}

// Starts the built API (dist/index.js) as its own process, so configuration is read exactly as in a deployment.
export async function startApiProcess(env: Record<string, string>): Promise<ApiProcess> {
  const port = await reservePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  let output = "";
  const child: ChildProcess = spawn(process.execPath, [fileURLToPath(new URL("../index.js", import.meta.url))], {
    env: { ...process.env, NODE_ENV: "development", API_PORT: String(port), FEATURE_REMOTE_BROWSER: "false", VRATA_DISABLE_AUTOSTART: "0", NOAH_DISABLE_AUTOSTART: "0", ...env },
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.stdout?.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  child.stderr?.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  const stop = async () => {
    if (child.exitCode !== null) return;
    const exited = once(child, "exit");
    child.kill("SIGTERM");
    if (!await Promise.race([exited.then(() => true), delay(5_000).then(() => false)]) && child.exitCode === null) {
      child.kill("SIGKILL");
      await once(child, "exit");
    }
  };
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`api_exited:${child.exitCode}\n${output}`);
    try {
      if ((await fetch(`${baseUrl}/health`)).ok) return { baseUrl, logs: () => output, stop };
    } catch {
      // Startup includes storage initialization, so connection failures are expected briefly.
    }
    await delay(200);
  }
  await stop();
  throw new Error(`api_start_timeout\n${output}`);
}
