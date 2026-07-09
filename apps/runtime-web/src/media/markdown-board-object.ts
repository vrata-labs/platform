import * as THREE from "three";
import {
  MARKDOWN_BOARD_MAX_TEXT_LENGTH,
  type MarkdownBoardPatch,
  type MarkdownBoardState,
  type MarkdownBoardStickyNote,
  type MediaObjectInstance,
  type RoomPermission
} from "@vrata/shared-types";

import { parseSafeMarkdown, type SafeMarkdownBlock } from "../notes.js";

export interface MarkdownBoardObjectRuntimeOptions {
  participantId: string;
  surfaceId: string;
  widthPx: number;
  heightPx: number;
  getPermissions: () => readonly RoomPermission[];
  applyTexture: (texture: THREE.Texture | null) => void;
}

export interface MarkdownBoardDebugSnapshot {
  objectId: string | null;
  surfaceId: string;
  active: boolean;
  noteCount: number;
  revision: number;
  localCanEdit: boolean;
  lastInputEventId: string | null;
  errorCode: string | null;
  notes: Array<Pick<MarkdownBoardStickyNote, "noteId" | "text" | "x" | "y" | "width" | "height">>;
}

export class MarkdownBoardObjectRuntime {
  readonly texture: THREE.CanvasTexture;

  private readonly canvas: HTMLCanvasElement;
  private readonly context: CanvasRenderingContext2D | null;
  private errorCode: string | null = null;
  private renderedSignature: string | null = null;

  constructor(private readonly options: MarkdownBoardObjectRuntimeOptions) {
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

  createDebugSnapshot(object: MediaObjectInstance<MarkdownBoardState> | null): MarkdownBoardDebugSnapshot {
    return {
      objectId: object?.objectId ?? null,
      surfaceId: object?.surfaceId ?? this.options.surfaceId,
      active: Boolean(object),
      noteCount: object?.state.notes.length ?? 0,
      revision: object?.revision ?? 0,
      localCanEdit: this.canEdit(),
      lastInputEventId: object?.state.lastInputEventId ?? null,
      errorCode: this.errorCode,
      notes: (object?.state.notes ?? []).map((note) => ({
        noteId: note.noteId,
        text: note.text,
        x: note.x,
        y: note.y,
        width: note.width,
        height: note.height
      }))
    };
  }

  render(state: MarkdownBoardState | null): void {
    if (!this.context) {
      return;
    }
    const signature = this.createRenderSignature(state);
    if (signature === this.renderedSignature) {
      return;
    }
    this.context.fillStyle = "#f8fafc";
    this.context.fillRect(0, 0, this.canvas.width, this.canvas.height);
    this.drawGrid();
    this.context.fillStyle = "rgba(15, 23, 42, 0.74)";
    this.context.font = "700 36px sans-serif";
    this.context.fillText("Markdown Sticky Board", 40, 64);
    for (const note of state?.notes ?? []) {
      this.drawNote(note);
    }
    this.texture.needsUpdate = true;
    this.renderedSignature = signature;
    this.options.applyTexture(this.texture);
  }

  clearError(): void {
    this.errorCode = null;
  }

  setError(errorCode: string | null): void {
    this.errorCode = errorCode;
  }

  createNotePatch(input: { text: string; x?: number; y?: number; width?: number; height?: number; color?: MarkdownBoardStickyNote["color"] }): MarkdownBoardPatch {
    return {
      type: "create-note",
      inputEventId: this.createInputEventId("create"),
      noteId: `${this.options.participantId}:note:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
      text: this.normalizeText(input.text),
      x: input.x ?? 0.08,
      y: input.y ?? 0.16,
      ...(input.width === undefined ? {} : { width: input.width }),
      ...(input.height === undefined ? {} : { height: input.height }),
      ...(input.color === undefined ? {} : { color: input.color })
    };
  }

  createUpdateNotePatch(noteId: string, text: string): MarkdownBoardPatch {
    return {
      type: "update-note",
      inputEventId: this.createInputEventId("update"),
      noteId,
      text: this.normalizeText(text)
    };
  }

  createMoveNotePatch(noteId: string, x: number, y: number): MarkdownBoardPatch {
    return {
      type: "move-note",
      inputEventId: this.createInputEventId("move"),
      noteId,
      x,
      y
    };
  }

  createDeleteNotePatch(noteId: string): MarkdownBoardPatch {
    return {
      type: "delete-note",
      inputEventId: this.createInputEventId("delete"),
      noteId
    };
  }

  private createRenderSignature(state: MarkdownBoardState | null): string {
    return [
      state?.revision ?? -1,
      state?.lastInputEventId ?? "",
      ...(state?.notes ?? []).map((note) => `${note.noteId}:${note.updatedAtMs}:${note.x}:${note.y}:${note.text}`)
    ].join("|");
  }

  private canEdit(): boolean {
    return this.options.getPermissions().includes("markdown-board.edit");
  }

  private createInputEventId(kind: string): string {
    return `${this.options.participantId}:markdown-board:${kind}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
  }

  private normalizeText(text: string): string {
    return text.replace(/\0/g, "").slice(0, MARKDOWN_BOARD_MAX_TEXT_LENGTH);
  }

  private drawGrid(): void {
    if (!this.context) {
      return;
    }
    this.context.strokeStyle = "rgba(37, 99, 235, 0.10)";
    this.context.lineWidth = 2;
    for (let x = 0; x <= this.canvas.width; x += 160) {
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
  }

  private drawNote(note: MarkdownBoardStickyNote): void {
    if (!this.context) {
      return;
    }
    const x = Math.min(this.canvas.width - 40, Math.max(0, note.x * this.canvas.width));
    const y = Math.min(this.canvas.height - 40, Math.max(0, note.y * this.canvas.height));
    const width = Math.max(180, Math.min(this.canvas.width - x, note.width * this.canvas.width));
    const height = Math.max(140, Math.min(this.canvas.height - y, note.height * this.canvas.height));
    this.context.save();
    this.context.shadowColor = "rgba(15, 23, 42, 0.25)";
    this.context.shadowBlur = 18;
    this.context.shadowOffsetY = 8;
    this.drawRoundedRect(x, y, width, height, 24);
    this.context.fillStyle = note.color;
    this.context.fill();
    this.context.restore();
    this.context.strokeStyle = "rgba(15, 23, 42, 0.18)";
    this.context.lineWidth = 3;
    this.drawRoundedRect(x, y, width, height, 24);
    this.context.stroke();
    this.renderMarkdownBlocks(parseSafeMarkdown(note.text), x + 24, y + 30, width - 48, height - 50);
  }

  private renderMarkdownBlocks(blocks: SafeMarkdownBlock[], x: number, y: number, width: number, height: number): void {
    if (!this.context) {
      return;
    }
    let cursorY = y;
    const bottom = y + height;
    for (const block of blocks) {
      if (cursorY > bottom) {
        break;
      }
      if (block.type === "heading") {
        const size = block.level === 1 ? 30 : block.level === 2 ? 25 : 21;
        this.context.font = `700 ${size}px sans-serif`;
        this.context.fillStyle = "#111827";
        cursorY = this.wrapText(block.text, x, cursorY, width, size + 6, bottom) + 8;
        continue;
      }
      if (block.type === "listItem") {
        this.context.font = "22px sans-serif";
        this.context.fillStyle = "#111827";
        this.context.fillText("-", x, cursorY);
        cursorY = this.wrapText(block.text, x + 22, cursorY, width - 22, 28, bottom) + 4;
        continue;
      }
      if (block.type === "code") {
        this.context.font = "19px monospace";
        this.context.fillStyle = "#334155";
        cursorY = this.wrapText(block.text, x, cursorY, width, 25, bottom) + 8;
        continue;
      }
      this.context.font = "22px sans-serif";
      this.context.fillStyle = "#1f2937";
      cursorY = this.wrapText(block.text, x, cursorY, width, 29, bottom) + 6;
    }
  }

  private wrapText(text: string, x: number, y: number, width: number, lineHeight: number, bottom: number): number {
    if (!this.context) {
      return y;
    }
    let cursorY = y;
    const sourceLines = text.split("\n");
    for (const sourceLine of sourceLines) {
      let line = "";
      for (const word of sourceLine.split(/\s+/).filter(Boolean)) {
        const next = line ? `${line} ${word}` : word;
        if (this.context.measureText(next).width > width && line) {
          this.context.fillText(line, x, cursorY);
          cursorY += lineHeight;
          line = word;
          if (cursorY > bottom) {
            return cursorY;
          }
        } else {
          line = next;
        }
      }
      if (line) {
        this.context.fillText(line, x, cursorY);
        cursorY += lineHeight;
      }
    }
    return cursorY;
  }

  private drawRoundedRect(x: number, y: number, width: number, height: number, radius: number): void {
    if (!this.context) {
      return;
    }
    const r = Math.min(radius, width / 2, height / 2);
    this.context.beginPath();
    this.context.moveTo(x + r, y);
    this.context.lineTo(x + width - r, y);
    this.context.quadraticCurveTo(x + width, y, x + width, y + r);
    this.context.lineTo(x + width, y + height - r);
    this.context.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
    this.context.lineTo(x + r, y + height);
    this.context.quadraticCurveTo(x, y + height, x, y + height - r);
    this.context.lineTo(x, y + r);
    this.context.quadraticCurveTo(x, y, x + r, y);
    this.context.closePath();
  }
}

export function createMarkdownBoardObjectRuntime(options: MarkdownBoardObjectRuntimeOptions): MarkdownBoardObjectRuntime {
  return new MarkdownBoardObjectRuntime(options);
}
