import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { absoluteDeadline, publicHttpsPublisher } from "./public-https-channel.js";
import type { PublicHttpsLeaseConsumer } from "./public-https-sessions.js";

type Tracks = { videoTrackSid: string; audioTrackSid: string };

export class PublicHttpsPublisher implements PublicHttpsLeaseConsumer {
  private child?: ChildProcess;
  private deadline?: string;
  private closed = false;
  finished: Promise<void> = Promise.resolve();

  constructor(private readonly onExit: () => void) {}

  setDeadline(deadline: number) {
    if (this.closed) throw new Error("public_https_publisher_closed");
    this.deadline = absoluteDeadline(deadline);
    this.child?.stdin?.write(`${this.deadline}\n`);
  }

  start(settings: { livekitUrl: string; token: string; display: string; pulseServer: string }): Promise<Tracks> {
    if (this.closed || this.child || !this.deadline) return Promise.reject(new Error("livekit_publish_failed"));
    const child = this.child = spawn(publicHttpsPublisher, ["apps/remote-browser/public-https-publisher.py"], {
      detached: true,
      stdio: ["pipe", "pipe", "ignore"],
      env: { PATH: process.env.PATH, HOME: "/tmp", LANG: "C.UTF-8", PULSE_SERVER: settings.pulseServer }
    });
    child.stdin!.on("error", () => this.revoke());
    child.stdin!.write(`${JSON.stringify({ ...settings, deadline: this.deadline })}\n`);
    this.finished = new Promise(resolve => child.once("close", () => resolve()));
    let published = false;
    return new Promise((resolve, reject) => {
      child.once("error", () => reject(new Error("livekit_publish_failed")));
      child.once("close", () => {
        reject(new Error("livekit_publish_failed"));
        if (published && !this.closed) this.onExit();
      });
      const output = createInterface({ input: child.stdout! });
      output.once("line", line => {
        try {
          const tracks = JSON.parse(line) as Partial<Tracks>;
          if (typeof tracks.videoTrackSid !== "string" || typeof tracks.audioTrackSid !== "string") throw new Error();
          published = true;
          resolve({ videoTrackSid: tracks.videoTrackSid, audioTrackSid: tracks.audioTrackSid });
        } catch {
          reject(new Error("livekit_publish_failed"));
        } finally {
          output.close();
        }
      });
    });
  }

  revoke() {
    if (this.closed) return;
    this.closed = true;
    const child = this.child;
    if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
    child.stdin?.end();
    const kill = setTimeout(() => {
      try { process.kill(-child.pid!, "SIGKILL"); } catch { /* Already exited. */ }
    }, 500);
    kill.unref();
    child.once("close", () => {
      clearTimeout(kill);
      // Kill captures if the publisher exited before reaping them.
      try { process.kill(-child.pid!, "SIGKILL"); } catch { /* Already exited. */ }
    });
  }
}
