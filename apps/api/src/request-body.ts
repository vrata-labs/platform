import type { IncomingMessage } from "node:http";

export function parseBody<T>(request: IncomingMessage): Promise<T | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    request.on("data", (chunk) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > 64 * 1024) {
        reject(new Error("payload_too_large"));
        request.destroy();
      }
    });
    request.on("end", () => {
      if (chunks.length === 0) return resolve(null);
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")) as T);
      } catch (error) {
        reject(error);
      }
    });
    request.on("error", reject);
  });
}

export function readRequestBuffer(request: IncomingMessage, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    request.on("data", (chunk) => {
      const buffer = Buffer.from(chunk);
      bytes += buffer.byteLength;
      if (bytes > maxBytes) {
        reject(new Error("payload_too_large"));
        request.destroy();
        return;
      }
      chunks.push(buffer);
    });
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}
