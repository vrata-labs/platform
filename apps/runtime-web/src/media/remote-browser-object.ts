import * as THREE from "three";
import type {
  MediaObjectInstance,
  RemoteBrowserObjectState,
  RemoteBrowserPatch,
  RoomPermission,
  SurfaceInputEvent,
  SurfaceInputKind
} from "@noah/shared-types";

import type { SurfaceCommandResult } from "../room-state-client.js";

interface RemoteBrowserFrameTokenResponse {
  frameStreamUrl?: string;
  expiresInSeconds?: number;
}

interface RemoteBrowserFrameMessage {
  type?: string;
  sessionId?: string;
  frameStreamId?: string;
  width?: number;
  height?: number;
  dataUrl?: string;
  capturedAtMs?: number;
}

export interface RemoteBrowserObjectRuntimeOptions {
  apiBaseUrl: string;
  roomId: string;
  participantId: string;
  surfaceId: string;
  widthPx: number;
  heightPx: number;
  getPermissions: () => readonly RoomPermission[];
  getLatestObject: (surfaceId: string) => MediaObjectInstance<RemoteBrowserObjectState> | null;
  patchObject: (objectId: string, surfaceId: string, expectedRevision: number, patch: RemoteBrowserPatch) => Promise<SurfaceCommandResult>;
  applyTexture: (texture: THREE.Texture | null) => void;
  onBlocked: (blockedReason: string | null, errorCode: string | null) => void;
}

export interface RemoteBrowserDebugSnapshot {
  objectId: string | null;
  surfaceId: string;
  active: boolean;
  status: RemoteBrowserObjectState["status"] | "idle";
  currentUrl: string | null;
  controllerParticipantId: string | null;
  executorSessionId: string | null;
  frameStreamId: string | null;
  frameConnected: boolean;
  frameStreamUrl: string | null;
  lastFrameAtMs: number;
  frameSize: { width: number; height: number } | null;
  localCanOpen: boolean;
  localCanInput: boolean;
  localHasControl: boolean;
  lastInputSeq: number;
  errorCode: string | null;
}

function remoteBrowserInputEventId(participantId: string, kind: string): string {
  return `${participantId}:remote-browser:${kind}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
}

function isKeyboardKind(kind: SurfaceInputKind): boolean {
  return kind === "key-down" || kind === "key-up";
}

function isPointerKind(kind: SurfaceInputKind): boolean {
  return kind === "pointer-down" || kind === "pointer-move" || kind === "pointer-up" || kind === "click";
}

function redactFrameStreamUrl(input: string): string {
  try {
    const url = new URL(input);
    if (url.searchParams.has("token")) {
      url.searchParams.set("token", "redacted");
    }
    return url.toString();
  } catch {
    return "redacted";
  }
}

export class RemoteBrowserObjectRuntime {
  readonly texture: THREE.CanvasTexture;

  private readonly canvas: HTMLCanvasElement;
  private readonly context: CanvasRenderingContext2D | null;
  private frameSocket: WebSocket | null = null;
  private frameStreamKey: string | null = null;
  private frameStreamUrl: string | null = null;
  private frameConnected = false;
  private lastFrameAtMs = 0;
  private frameSize: { width: number; height: number } | null = null;
  private errorCode: string | null = null;
  private renderedPlaceholder = "";

  constructor(private readonly options: RemoteBrowserObjectRuntimeOptions) {
    this.canvas = document.createElement("canvas");
    this.canvas.width = options.widthPx;
    this.canvas.height = options.heightPx;
    this.context = this.canvas.getContext("2d");
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.renderPlaceholder("Remote Browser", "Open an allowed URL to start.");
  }

  ownsTexture(texture: THREE.Texture | null | undefined): boolean {
    return texture === this.texture;
  }

  createOpenUrlPatch(url: string): RemoteBrowserPatch {
    return {
      type: "open-url",
      url,
      inputEventId: remoteBrowserInputEventId(this.options.participantId, "open-url")
    };
  }

  createTakeControlPatch(): RemoteBrowserPatch {
    return {
      type: "take-control",
      inputEventId: remoteBrowserInputEventId(this.options.participantId, "take-control")
    };
  }

  createReleaseControlPatch(): RemoteBrowserPatch {
    return {
      type: "release-control",
      inputEventId: remoteBrowserInputEventId(this.options.participantId, "release-control")
    };
  }

  clearError(): void {
    this.errorCode = null;
  }

  setError(errorCode: string | null): void {
    this.errorCode = errorCode;
  }

  close(): void {
    this.closeFrameStream();
  }

  sync(object: MediaObjectInstance<RemoteBrowserObjectState> | null): void {
    if (!object) {
      this.closeFrameStream();
      return;
    }
    this.options.applyTexture(this.texture);
    const state = object.state;
    if (!state.executorSessionId || !state.frameStreamId) {
      this.closeFrameStream();
      this.renderPlaceholder("Remote Browser", state.currentUrl ? "Starting executor..." : "Open an allowed URL to start.");
      return;
    }
    this.ensureFrameStream(object);
    if (this.lastFrameAtMs <= 0) {
      this.renderPlaceholder("Remote Browser", state.currentUrl ?? "Waiting for first frame...");
    }
  }

  createDebugSnapshot(object: MediaObjectInstance<RemoteBrowserObjectState> | null): RemoteBrowserDebugSnapshot {
    const permissions = this.options.getPermissions();
    const state = object?.state ?? null;
    const controllerParticipantId = state?.controllerParticipantId ?? null;
    return {
      objectId: object?.objectId ?? null,
      surfaceId: object?.surfaceId ?? this.options.surfaceId,
      active: Boolean(object),
      status: state?.status ?? "idle",
      currentUrl: state?.currentUrl ?? null,
      controllerParticipantId,
      executorSessionId: state?.executorSessionId ?? null,
      frameStreamId: state?.frameStreamId ?? null,
      frameConnected: this.frameConnected,
      frameStreamUrl: this.frameStreamUrl,
      lastFrameAtMs: this.lastFrameAtMs,
      frameSize: this.frameSize,
      localCanOpen: permissions.includes("remote-browser.open-url"),
      localCanInput: permissions.includes("remote-browser.input"),
      localHasControl: !controllerParticipantId || controllerParticipantId === this.options.participantId,
      lastInputSeq: state?.lastInputSeq ?? 0,
      errorCode: state?.errorCode ?? this.errorCode
    };
  }

  routeInput(event: SurfaceInputEvent, object: MediaObjectInstance<RemoteBrowserObjectState>): boolean {
    if (!this.canInput(object.state)) {
      this.reportBlocked("missing-permission", "missing-permission:remote-browser.input");
      return false;
    }
    if (object.state.controllerParticipantId && object.state.controllerParticipantId !== this.options.participantId) {
      this.reportBlocked("invalid-patch", "remote-browser:controlled-by-other");
      return false;
    }
    const patch = this.patchFromInputEvent(event);
    if (!patch) {
      return false;
    }
    this.sendPatch(object, patch);
    return true;
  }

  private canInput(state: RemoteBrowserObjectState): boolean {
    return Boolean(state.executorSessionId) && this.options.getPermissions().includes("remote-browser.input");
  }

  private patchFromInputEvent(event: SurfaceInputEvent): RemoteBrowserPatch | null {
    if (event.kind === "scroll") {
      return { type: "scroll", event, inputEventId: event.eventId };
    }
    if (isKeyboardKind(event.kind)) {
      return { type: "keyboard", event, inputEventId: event.eventId };
    }
    if (isPointerKind(event.kind)) {
      return { type: "pointer", event, inputEventId: event.eventId };
    }
    return null;
  }

  private sendPatch(object: MediaObjectInstance<RemoteBrowserObjectState>, patch: RemoteBrowserPatch): void {
    const sendAttempt = (target: MediaObjectInstance<RemoteBrowserObjectState>, allowRevisionRetry: boolean): void => {
      void this.options.patchObject(target.objectId, target.surfaceId, target.revision, patch).then((result) => {
        if (result.accepted) {
          this.reportBlocked(null, null);
          return;
        }
        this.reportBlocked(result.blockedReason ?? null, result.blockedReason ?? "patch-rejected");
        if (allowRevisionRetry && result.blockedReason === "revision-mismatch") {
          const latest = this.options.getLatestObject(target.surfaceId);
          if (latest && latest.objectId === target.objectId && latest.revision !== target.revision) {
            sendAttempt(latest, false);
          }
        }
      }).catch((error: unknown) => {
        this.reportBlocked(null, error instanceof Error ? error.message : "patch-failed");
      });
    };
    sendAttempt(object, true);
  }

  private ensureFrameStream(object: MediaObjectInstance<RemoteBrowserObjectState>): void {
    const { executorSessionId, frameStreamId } = object.state;
    if (!executorSessionId || !frameStreamId) {
      return;
    }
    const key = `${object.roomId}:${object.objectId}:${executorSessionId}:${frameStreamId}`;
    if (this.frameStreamKey === key && this.frameSocket) {
      return;
    }
    this.closeFrameStream();
    this.frameStreamKey = key;
    void this.connectFrameStream(object, key);
  }

  private async connectFrameStream(object: MediaObjectInstance<RemoteBrowserObjectState>, key: string): Promise<void> {
    try {
      const tokenResponse = await fetch(new URL("/api/tokens/remote-browser-frame", this.options.apiBaseUrl), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          roomId: object.roomId,
          objectId: object.objectId,
          executorSessionId: object.state.executorSessionId,
          frameStreamId: object.state.frameStreamId
        })
      });
      if (!tokenResponse.ok) {
        throw new Error(`remote_browser_frame_token_failed:${tokenResponse.status}`);
      }
      const payload = await tokenResponse.json() as RemoteBrowserFrameTokenResponse;
      if (!payload.frameStreamUrl) {
        throw new Error("remote_browser_frame_token_missing_url");
      }
      if (this.frameStreamKey !== key) {
        return;
      }
      this.frameStreamUrl = redactFrameStreamUrl(payload.frameStreamUrl);
      const socket = new WebSocket(payload.frameStreamUrl);
      this.frameSocket = socket;
      socket.addEventListener("open", () => {
        if (this.frameSocket === socket) {
          this.frameConnected = true;
          this.errorCode = null;
        }
      });
      socket.addEventListener("message", (event) => {
        if (this.frameSocket !== socket) {
          return;
        }
        this.handleFrameMessage(String(event.data));
      });
      socket.addEventListener("close", () => {
        if (this.frameSocket === socket) {
          this.frameConnected = false;
          this.frameSocket = null;
          this.frameStreamKey = null;
        }
      });
      socket.addEventListener("error", () => {
        if (this.frameSocket === socket) {
          this.errorCode = "stream_failed";
          this.frameConnected = false;
        }
      });
    } catch (error) {
      if (this.frameStreamKey === key) {
        this.frameStreamKey = null;
      }
      this.reportBlocked(null, error instanceof Error ? error.message : "remote_browser_frame_connect_failed");
      this.renderPlaceholder("Remote Browser", "Frame stream unavailable.");
    }
  }

  private handleFrameMessage(message: string): void {
    let payload: RemoteBrowserFrameMessage;
    try {
      payload = JSON.parse(message) as RemoteBrowserFrameMessage;
    } catch {
      return;
    }
    if (payload.type !== "frame" || !payload.dataUrl) {
      return;
    }
    const image = new Image();
    image.onload = () => {
      if (!this.context) {
        return;
      }
      this.context.fillStyle = "#020617";
      this.context.fillRect(0, 0, this.canvas.width, this.canvas.height);
      this.context.drawImage(image, 0, 0, this.canvas.width, this.canvas.height);
      this.texture.needsUpdate = true;
      this.lastFrameAtMs = payload.capturedAtMs ?? Date.now();
      this.frameSize = {
        width: payload.width ?? image.width,
        height: payload.height ?? image.height
      };
      this.renderedPlaceholder = "";
      this.options.applyTexture(this.texture);
    };
    image.src = payload.dataUrl;
  }

  private closeFrameStream(): void {
    const socket = this.frameSocket;
    this.frameSocket = null;
    this.frameStreamKey = null;
    this.frameStreamUrl = null;
    this.frameConnected = false;
    if (socket && socket.readyState !== socket.CLOSED && socket.readyState !== socket.CLOSING) {
      socket.close(1000, "runtime_disconnect");
    }
  }

  private renderPlaceholder(title: string, subtitle: string): void {
    const signature = `${title}:${subtitle}`;
    if (signature === this.renderedPlaceholder || !this.context) {
      this.options.applyTexture(this.texture);
      return;
    }
    const gradient = this.context.createLinearGradient(0, 0, this.canvas.width, this.canvas.height);
    gradient.addColorStop(0, "#0f172a");
    gradient.addColorStop(1, "#1d4ed8");
    this.context.fillStyle = gradient;
    this.context.fillRect(0, 0, this.canvas.width, this.canvas.height);
    this.context.fillStyle = "rgba(255, 255, 255, 0.12)";
    this.context.fillRect(80, 80, this.canvas.width - 160, this.canvas.height - 160);
    this.context.fillStyle = "#f8fafc";
    this.context.font = "bold 64px sans-serif";
    this.context.fillText(title, 140, 210);
    this.context.font = "36px sans-serif";
    this.context.fillText(subtitle.slice(0, 80), 140, 290);
    this.texture.needsUpdate = true;
    this.renderedPlaceholder = signature;
    this.options.applyTexture(this.texture);
  }

  private reportBlocked(blockedReason: string | null, errorCode: string | null): void {
    this.errorCode = errorCode;
    this.options.onBlocked(blockedReason, errorCode);
  }
}

export function createRemoteBrowserObjectRuntime(options: RemoteBrowserObjectRuntimeOptions): RemoteBrowserObjectRuntime {
  return new RemoteBrowserObjectRuntime(options);
}
