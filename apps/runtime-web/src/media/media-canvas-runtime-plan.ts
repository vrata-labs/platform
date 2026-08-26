import {
  MARKDOWN_BOARD_OBJECT_TYPE,
  REMOTE_BROWSER_OBJECT_TYPE,
  WHITEBOARD_OBJECT_TYPE
} from "@vrata/shared-types";

export type MediaCanvasRuntimeKind = "whiteboard" | "markdown-board" | "remote-browser";

export interface MediaCanvasRuntimeAllocation {
  surfaceId: string;
  widthPx: number;
  heightPx: number;
  kind: MediaCanvasRuntimeKind;
}

export type MediaCanvasRuntimeAllocators = Record<MediaCanvasRuntimeKind, (allocation: MediaCanvasRuntimeAllocation) => void>;

export function planMediaCanvasRuntimeAllocations(surfaces: Array<{
  surfaceId: string;
  widthPx: number;
  heightPx: number;
  activeObjectType: string | null;
}>): MediaCanvasRuntimeAllocation[] {
  const allocations: MediaCanvasRuntimeAllocation[] = [];
  for (const surface of surfaces) {
    const kind = surface.activeObjectType === WHITEBOARD_OBJECT_TYPE
      ? "whiteboard"
      : surface.activeObjectType === MARKDOWN_BOARD_OBJECT_TYPE
        ? "markdown-board"
        : surface.activeObjectType === REMOTE_BROWSER_OBJECT_TYPE
          ? "remote-browser"
          : null;
    if (kind) {
      allocations.push({
        surfaceId: surface.surfaceId,
        widthPx: surface.widthPx,
        heightPx: surface.heightPx,
        kind
      });
    }
  }
  return allocations;
}

export function allocatePlannedMediaCanvasRuntimes(
  allocations: readonly MediaCanvasRuntimeAllocation[],
  allocators: MediaCanvasRuntimeAllocators
): void {
  for (const allocation of allocations) {
    allocators[allocation.kind](allocation);
  }
}

export function releaseMediaCanvasRuntime<Texture>(input: {
  currentTexture: Texture | null | undefined;
  ownsTexture: (texture: Texture | null | undefined) => boolean;
  clearOwnedTexture: () => void;
  dispose: () => void;
}): void {
  if (input.ownsTexture(input.currentTexture)) {
    input.clearOwnedTexture();
  }
  input.dispose();
}
