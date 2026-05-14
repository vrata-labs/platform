import { createHmac, timingSafeEqual } from "node:crypto";

export interface RemoteBrowserFrameTokenPayload {
  roomId: string;
  objectId: string;
  executorSessionId: string;
  frameStreamId: string;
  exp: number;
}

function signBody(body: string, secret: string): string {
  return createHmac("sha256", secret).update(body).digest("base64url");
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

export function encodeRemoteBrowserFrameToken(payload: RemoteBrowserFrameTokenPayload, secret: string): string {
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${body}.${signBody(body, secret)}`;
}

export function decodeRemoteBrowserFrameToken(token: string | null | undefined, secret: string): RemoteBrowserFrameTokenPayload | null {
  if (!token) {
    return null;
  }
  const [body, signature] = token.split(".");
  if (!body || !signature || !safeEqual(signBody(body, secret), signature)) {
    return null;
  }
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Partial<RemoteBrowserFrameTokenPayload>;
    if (typeof payload.roomId !== "string"
      || typeof payload.objectId !== "string"
      || typeof payload.executorSessionId !== "string"
      || typeof payload.frameStreamId !== "string"
      || typeof payload.exp !== "number"
      || payload.exp < Math.floor(Date.now() / 1000)) {
      return null;
    }
    return payload as RemoteBrowserFrameTokenPayload;
  } catch {
    return null;
  }
}
