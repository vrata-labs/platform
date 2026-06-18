import * as THREE from "three";
import {
  WHITEBOARD_MAX_POINTS_PER_STROKE,
  type MediaObjectInstance,
  type RoomPermission,
  type SurfaceInputEvent,
  type SurfaceInputSource,
  type WhiteboardPatch,
  type WhiteboardPoint,
  type WhiteboardState,
  type WhiteboardStroke
} from "@vrata/shared-types";

import type { SurfaceCommandResult } from "../room-state-client.js";

export interface WhiteboardObjectRuntimeOptions {
  participantId: string;
  surfaceId: string;
  widthPx: number;
  heightPx: number;
  getPermissions: () => readonly RoomPermission[];
  getLatestObject: (surfaceId: string) => MediaObjectInstance<WhiteboardState> | null;
  patchObject: (objectId: string, surfaceId: string, expectedRevision: number, patch: WhiteboardPatch) => Promise<SurfaceCommandResult>;
  applyTexture: (texture: THREE.Texture | null) => void;
  applyPreview: (stroke: WhiteboardStroke | null) => void;
  onBlocked: (blockedReason: string | null, errorCode: string | null) => void;
}

export interface WhiteboardDebugSnapshot {
  objectId: string | null;
  surfaceId: string;
  active: boolean;
  strokeCount: number;
  revision: number;
  localCanDraw: boolean;
  localCanClear: boolean;
  localPreviewPointCount: number;
  lastInputSource: SurfaceInputSource | null;
  lastPoint: null | { u: number; v: number };
  errorCode: string | null;
}

export function whiteboardPointFromSurfaceInput(event: SurfaceInputEvent): WhiteboardPoint | null {
  if (!event.uv) {
    return null;
  }
  return {
    u: event.uv.u,
    v: 1 - event.uv.v,
    t: event.clientTimeMs,
    ...(event.pressure === undefined ? {} : { pressure: event.pressure })
  };
}

export class WhiteboardObjectRuntime {
  readonly texture: THREE.CanvasTexture;

  private readonly canvas: HTMLCanvasElement;
  private readonly context: CanvasRenderingContext2D | null;
  private localPreview: WhiteboardStroke | null = null;
  private lastInputSource: SurfaceInputSource | null = null;
  private lastPoint: null | { u: number; v: number } = null;
  private errorCode: string | null = null;
  private renderedSignature: string | null = null;

  constructor(private readonly options: WhiteboardObjectRuntimeOptions) {
    this.canvas = document.createElement("canvas");
    this.canvas.width = options.widthPx;
    this.canvas.height = options.heightPx;
    this.context = this.canvas.getContext("2d");
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
  }

  ownsTexture(texture: THREE.Texture | null | undefined): boolean {
    return texture === this.texture;
  }

  createDebugSnapshot(object: MediaObjectInstance<WhiteboardState> | null): WhiteboardDebugSnapshot {
    const permissions = this.options.getPermissions();
    return {
      objectId: object?.objectId ?? null,
      surfaceId: object?.surfaceId ?? this.options.surfaceId,
      active: Boolean(object),
      strokeCount: object?.state.strokes.length ?? 0,
      revision: object?.revision ?? 0,
      localCanDraw: permissions.includes("whiteboard.draw"),
      localCanClear: permissions.includes("whiteboard.clear"),
      localPreviewPointCount: this.localPreview?.points.length ?? 0,
      lastInputSource: this.lastInputSource,
      lastPoint: this.lastPoint,
      errorCode: this.errorCode
    };
  }

  render(state: WhiteboardState | null): void {
    if (!this.context) {
      return;
    }
    const signature = this.createRenderSignature(state);
    if (signature === this.renderedSignature) {
      return;
    }
    this.context.fillStyle = "#f8fafc";
    this.context.fillRect(0, 0, this.canvas.width, this.canvas.height);
    this.context.strokeStyle = "rgba(37, 99, 235, 0.12)";
    this.context.lineWidth = 2;
    for (let x = 0; x <= this.canvas.width; x += 120) {
      this.context.beginPath();
      this.context.moveTo(x, 0);
      this.context.lineTo(x, this.canvas.height);
      this.context.stroke();
    }
    for (let y = 0; y <= this.canvas.height; y += 120) {
      this.context.beginPath();
      this.context.moveTo(0, y);
      this.context.lineTo(this.canvas.width, y);
      this.context.stroke();
    }
    for (const stroke of state?.strokes ?? []) {
      this.drawStroke(stroke);
    }
    this.context.fillStyle = "rgba(15, 23, 42, 0.72)";
    this.context.font = "36px sans-serif";
    this.context.fillText("Vrata Whiteboard", 40, 64);
    this.texture.needsUpdate = true;
    this.renderedSignature = signature;
    this.options.applyTexture(this.texture);
  }

  clearPreview(): void {
    if (this.localPreview) {
      this.localPreview = null;
      this.options.applyPreview(null);
    }
  }

  clearError(): void {
    this.errorCode = null;
  }

  setError(errorCode: string | null): void {
    this.errorCode = errorCode;
  }

  createClearPatch(): WhiteboardPatch {
    return {
      type: "clear",
      inputEventId: `${this.options.participantId}:clear:${Date.now()}`
    };
  }

  routeInput(event: SurfaceInputEvent, object: MediaObjectInstance<WhiteboardState>): boolean {
    const point = whiteboardPointFromSurfaceInput(event);
    if (!point) {
      return false;
    }
    this.lastInputSource = event.source;
    this.lastPoint = { u: point.u, v: point.v };

    if (event.kind === "pointer-down") {
      if (!this.canDraw()) {
        this.reportBlocked("missing-permission", "missing-permission:whiteboard.draw");
        return false;
      }
      this.localPreview = this.createLocalStroke(point);
      this.options.applyPreview(this.localPreview);
      return true;
    }

    if (event.kind === "pointer-move") {
      if (!this.localPreview) {
        return false;
      }
      const nextPreview = this.appendPreviewPoint(this.localPreview, point);
      if (nextPreview === this.localPreview) {
        return true;
      }
      this.localPreview = nextPreview;
      this.options.applyPreview(this.localPreview);
      return true;
    }

    if (event.kind === "pointer-up") {
      if (!this.canDraw()) {
        this.reportBlocked("missing-permission", "missing-permission:whiteboard.draw");
        return false;
      }
      if (!this.localPreview) {
        return false;
      }
      const stroke = this.appendPreviewPoint(this.localPreview, point);
      this.localPreview = null;
      this.options.applyPreview(null);
      this.sendPatch(object, {
        type: "append-stroke",
        inputEventId: event.eventId,
        stroke
      });
      return true;
    }

    if (event.kind === "click") {
      if (!this.canDraw()) {
        this.reportBlocked("missing-permission", "missing-permission:whiteboard.draw");
        return false;
      }
      this.sendPatch(object, {
        type: "append-stroke",
        inputEventId: event.eventId,
        stroke: this.createLocalStroke(point)
      });
      return true;
    }

    return false;
  }

  private createRenderSignature(state: WhiteboardState | null): string {
    return [
      state?.revision ?? -1,
      state?.lastInputEventId ?? "",
      state?.strokes.length ?? 0
    ].join(":");
  }

  private canDraw(): boolean {
    return this.options.getPermissions().includes("whiteboard.draw");
  }

  private drawStroke(stroke: WhiteboardStroke): void {
    if (!this.context || stroke.points.length === 0) {
      return;
    }
    this.context.strokeStyle = stroke.color;
    this.context.fillStyle = stroke.color;
    this.context.lineWidth = stroke.width * 2;
    this.context.lineCap = "round";
    this.context.lineJoin = "round";
    this.context.beginPath();
    const first = stroke.points[0]!;
    this.context.moveTo(first.u * this.canvas.width, first.v * this.canvas.height);
    for (const point of stroke.points.slice(1)) {
      this.context.lineTo(point.u * this.canvas.width, point.v * this.canvas.height);
    }
    if (stroke.points.length === 1) {
      this.context.arc(first.u * this.canvas.width, first.v * this.canvas.height, Math.max(2, stroke.width), 0, Math.PI * 2);
      this.context.fill();
    } else {
      this.context.stroke();
    }
  }

  private createLocalStroke(point: WhiteboardPoint): WhiteboardStroke {
    return {
      strokeId: `${this.options.participantId}:stroke:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
      participantId: this.options.participantId,
      tool: "pen",
      color: "#2563eb",
      width: 4,
      points: [point]
    };
  }

  private appendPreviewPoint(stroke: WhiteboardStroke, point: WhiteboardPoint): WhiteboardStroke {
    const previous = stroke.points[stroke.points.length - 1];
    if (previous && Math.hypot(previous.u - point.u, previous.v - point.v) < 0.002) {
      return stroke;
    }
    return {
      ...stroke,
      points: [...stroke.points, point].slice(-WHITEBOARD_MAX_POINTS_PER_STROKE)
    };
  }

  private sendPatch(object: MediaObjectInstance<WhiteboardState>, patch: WhiteboardPatch): void {
    const sendAttempt = (target: MediaObjectInstance<WhiteboardState>, allowRevisionRetry: boolean): void => {
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

  private reportBlocked(blockedReason: string | null, errorCode: string | null): void {
    this.errorCode = errorCode;
    this.options.onBlocked(blockedReason, errorCode);
  }
}

export function createWhiteboardObjectRuntime(options: WhiteboardObjectRuntimeOptions): WhiteboardObjectRuntime {
  return new WhiteboardObjectRuntime(options);
}
