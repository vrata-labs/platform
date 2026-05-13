import {
  SCREEN_SHARE_OBJECT_TYPE,
  WHITEBOARD_OBJECT_TYPE,
  type ScreenSharePatch,
  type WhiteboardPatch
} from "@noah/shared-types";

import {
  sendSurfaceCreateObjectCommand,
  sendSurfaceMediaAudioCommand,
  sendSurfacePatchObjectStateCommand,
  sendSurfaceStopObjectCommand,
  type RoomStateClient,
  type SurfaceCommandResult
} from "../room-state-client.js";

export interface MediaSurfaceCommandClientOptions {
  participantId: string;
  getClient: () => RoomStateClient | null;
  isConnected: () => boolean;
  createConnectionError: () => Error;
}

interface PendingSurfaceCommand {
  resolve: (result: SurfaceCommandResult) => void;
  reject: (error: Error) => void;
  timeoutId: number;
}

export class MediaSurfaceCommandClient {
  private readonly pending = new Map<string, PendingSurfaceCommand>();

  constructor(private readonly options: MediaSurfaceCommandClientOptions) {}

  createCommandId(kind: string): string {
    return `${this.options.participantId}:${kind}:${Date.now()}:${Math.random().toString(16).slice(2)}`;
  }

  settle(result: SurfaceCommandResult): void {
    if (!result.commandId) {
      return;
    }
    const pending = this.pending.get(result.commandId);
    if (!pending) {
      return;
    }
    window.clearTimeout(pending.timeoutId);
    this.pending.delete(result.commandId);
    pending.resolve(result);
  }

  rejectAll(reason: string): void {
    for (const [commandId, pending] of this.pending.entries()) {
      window.clearTimeout(pending.timeoutId);
      pending.reject(new Error(`${reason}:${commandId}`));
    }
    this.pending.clear();
  }

  sendAndWait(commandId: string, send: (client: RoomStateClient) => void): Promise<SurfaceCommandResult> {
    const client = this.requireClient();
    return new Promise((resolve, reject) => {
      const timeoutId = window.setTimeout(() => {
        this.pending.delete(commandId);
        reject(new Error(`surface_command_timeout:${commandId}`));
      }, 10000);
      this.pending.set(commandId, { resolve, reject, timeoutId });
      try {
        send(client);
      } catch (error) {
        window.clearTimeout(timeoutId);
        this.pending.delete(commandId);
        reject(error instanceof Error ? error : new Error("surface_command_send_failed"));
      }
    });
  }

  sendPatchObjectState(kind: string, input: {
    surfaceId: string;
    objectId: string;
    expectedRevision: number;
    patch: unknown;
  }): boolean {
    const client = this.getClientIfConnected();
    if (!client) {
      return false;
    }
    sendSurfacePatchObjectStateCommand(client, {
      commandId: this.createCommandId(kind),
      surfaceId: input.surfaceId,
      objectId: input.objectId,
      expectedRevision: input.expectedRevision,
      patch: input.patch
    });
    return true;
  }

  sendCreateObject(input: {
    commandId?: string;
    surfaceId?: string;
    objectType?: string;
    probeOnly?: boolean;
  } = {}): boolean {
    const client = this.getClientIfConnected();
    if (!client) {
      return false;
    }
    sendSurfaceCreateObjectCommand(client, input);
    return true;
  }

  sendStopObject(input: {
    commandId?: string;
    surfaceId: string;
    objectId: string;
  }): boolean {
    const client = this.getClientIfConnected();
    if (!client) {
      return false;
    }
    sendSurfaceStopObjectCommand(client, input);
    return true;
  }

  sendMediaAudio(input: {
    commandId?: string;
    surfaceId: string;
    enabled: boolean;
  }): boolean {
    const client = this.getClientIfConnected();
    if (!client) {
      return false;
    }
    sendSurfaceMediaAudioCommand(client, input);
    return true;
  }

  createObjectOnSurface(surfaceId: string, objectType: string, kind = "create"): Promise<SurfaceCommandResult> {
    const commandId = this.createCommandId(kind);
    return this.sendAndWait(commandId, (client) => {
      sendSurfaceCreateObjectCommand(client, {
        commandId,
        surfaceId,
        objectType,
        probeOnly: false
      });
    });
  }

  patchObjectState(objectId: string, surfaceId: string, expectedRevision: number, patch: unknown, kind = "patch"): Promise<SurfaceCommandResult> {
    const commandId = this.createCommandId(kind);
    return this.sendAndWait(commandId, (client) => {
      sendSurfacePatchObjectStateCommand(client, {
        commandId,
        surfaceId,
        objectId,
        expectedRevision,
        patch
      });
    });
  }

  stopObject(objectId: string, surfaceId: string, kind = "stop"): Promise<SurfaceCommandResult> {
    const commandId = this.createCommandId(kind);
    return this.sendAndWait(commandId, (client) => {
      sendSurfaceStopObjectCommand(client, {
        commandId,
        surfaceId,
        objectId
      });
    });
  }

  createScreenShareObjectOnSurface(surfaceId: string): Promise<SurfaceCommandResult> {
    return this.createObjectOnSurface(surfaceId, SCREEN_SHARE_OBJECT_TYPE, "screen-share-create");
  }

  patchScreenShareObject(objectId: string, surfaceId: string, expectedRevision: number, patch: ScreenSharePatch): Promise<SurfaceCommandResult> {
    return this.patchObjectState(objectId, surfaceId, expectedRevision, patch, `screen-share-${patch.type}`);
  }

  stopScreenShareObject(objectId: string, surfaceId: string): Promise<SurfaceCommandResult> {
    return this.stopObject(objectId, surfaceId, "screen-share-stop");
  }

  createWhiteboardObjectOnSurface(surfaceId: string): Promise<SurfaceCommandResult> {
    return this.createObjectOnSurface(surfaceId, WHITEBOARD_OBJECT_TYPE, "whiteboard-create");
  }

  patchWhiteboardObject(objectId: string, surfaceId: string, expectedRevision: number, patch: WhiteboardPatch): Promise<SurfaceCommandResult> {
    return this.patchObjectState(objectId, surfaceId, expectedRevision, patch, `whiteboard-${patch.type}`);
  }

  setMediaSurfaceAudioEnabled(surfaceId: string, enabled: boolean): Promise<SurfaceCommandResult> {
    const commandId = this.createCommandId("surface-audio");
    return this.sendAndWait(commandId, (client) => {
      sendSurfaceMediaAudioCommand(client, {
        commandId,
        surfaceId,
        enabled
      });
    });
  }

  private requireClient(): RoomStateClient {
    const client = this.getClientIfConnected();
    if (!client) {
      throw this.options.createConnectionError();
    }
    return client;
  }

  private getClientIfConnected(): RoomStateClient | null {
    const client = this.options.getClient();
    return client && this.options.isConnected() ? client : null;
  }
}

export function createMediaSurfaceCommandClient(options: MediaSurfaceCommandClientOptions): MediaSurfaceCommandClient {
  return new MediaSurfaceCommandClient(options);
}
