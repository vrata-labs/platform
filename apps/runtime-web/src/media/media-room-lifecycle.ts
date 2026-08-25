export type MediaRoomIdleAction = "schedule-disconnect" | "keep-room" | "ignore-stale-room";
export type PassiveMediaOwnershipEvent = "startup-requested" | "startup-succeeded" | "startup-failed";

export interface MediaRoomIdleScheduler<Room> {
  clear(): void;
  reconcile(room: Room, action: MediaRoomIdleAction, onDeadline: () => void): void;
}

export interface DeferredMediaStopQueue {
  enqueue(objectId: string, surfaceId: string): void;
  clear(): void;
  size(): number;
  flush(options: {
    canSend: boolean;
    isStillActive: (objectId: string, surfaceId: string) => boolean;
    send: (objectId: string, surfaceId: string) => Promise<boolean>;
  }): Promise<void>;
}

export function createDeferredMediaStopQueue(): DeferredMediaStopQueue {
  const pending = new Map<string, string>();
  const inFlight = new Set<string>();
  return {
    enqueue(objectId, surfaceId): void {
      pending.set(objectId, surfaceId);
    },
    clear(): void {
      pending.clear();
    },
    size(): number {
      return pending.size;
    },
    async flush(options): Promise<void> {
      if (!options.canSend) {
        return;
      }
      await Promise.all(Array.from(pending.entries()).map(async ([objectId, surfaceId]) => {
        if (!options.isStillActive(objectId, surfaceId)) {
          pending.delete(objectId);
          return;
        }
        if (inFlight.has(objectId)) {
          return;
        }
        inFlight.add(objectId);
        try {
          if (await options.send(objectId, surfaceId)) {
            pending.delete(objectId);
          }
        } catch {
          // Keep the stop intent for the next room-state reconnect.
        } finally {
          inFlight.delete(objectId);
        }
      }));
    }
  };
}

export function cleanupMediaRoomConsumers<ScreenShare, RemoteBrowserVideo>(input: {
  screenShares: Iterable<ScreenShare>;
  remoteBrowserVideos: Iterable<RemoteBrowserVideo>;
  surfaceAudioIds: Iterable<string>;
  remoteAudioParticipantIds: Iterable<string>;
  detachScreenShare: (entry: ScreenShare) => void;
  detachRemoteBrowserVideo: (entry: RemoteBrowserVideo) => void;
  disconnectSurfaceAudio: (surfaceId: string) => void;
  disconnectRemoteAudio: (participantId: string) => void;
  shouldDetachScreenShare?: (entry: ScreenShare) => boolean;
}): void {
  for (const entry of Array.from(input.screenShares)) {
    if (input.shouldDetachScreenShare?.(entry) === false) {
      continue;
    }
    input.detachScreenShare(entry);
  }
  for (const entry of Array.from(input.remoteBrowserVideos)) {
    input.detachRemoteBrowserVideo(entry);
  }
  for (const surfaceId of Array.from(input.surfaceAudioIds)) {
    input.disconnectSurfaceAudio(surfaceId);
  }
  for (const participantId of Array.from(input.remoteAudioParticipantIds)) {
    input.disconnectRemoteAudio(participantId);
  }
}

export function shouldHandleMediaRoomEvent<Room>(currentRoom: Room | null, eventRoom: Room): boolean {
  return currentRoom === eventRoom;
}

export function createMediaRoomIdleScheduler<Room, Timer>(options: {
  delayMs: number;
  setTimer: (callback: () => void, delayMs: number) => Timer;
  clearTimer: (timer: Timer) => void;
}): MediaRoomIdleScheduler<Room> {
  let pendingRoom: Room | null = null;
  let pendingTimer: Timer | null = null;

  const clear = (): void => {
    if (pendingTimer !== null) {
      options.clearTimer(pendingTimer);
    }
    pendingTimer = null;
    pendingRoom = null;
  };

  return {
    clear,
    reconcile(room, action, onDeadline): void {
      if (action === "keep-room") {
        clear();
        return;
      }
      if (action !== "schedule-disconnect") {
        return;
      }
      if (pendingTimer !== null && pendingRoom === room) {
        return;
      }
      clear();
      pendingRoom = room;
      pendingTimer = options.setTimer(() => {
        if (pendingRoom !== room) {
          return;
        }
        pendingTimer = null;
        pendingRoom = null;
        onDeadline();
      }, options.delayMs);
    }
  };
}

export function transitionPassiveMediaOwnership(current: boolean, event: PassiveMediaOwnershipEvent): boolean {
  if (event === "startup-requested") {
    return true;
  }
  if (event === "startup-failed") {
    return false;
  }
  return current;
}

export function hasMediaRoomSurfaceConsumer(input: {
  screenShare: boolean;
  remoteBrowser: boolean;
  surfaceAudio: boolean;
}): boolean {
  return input.screenShare || input.remoteBrowser || input.surfaceAudio;
}

export function planMediaRoomIdleAction(input: {
  roomIsCurrent: boolean;
  audioSessionJoined: boolean;
  hasPhysicalConsumer: boolean;
  passiveMediaRequired: boolean;
}): MediaRoomIdleAction {
  if (!input.roomIsCurrent) {
    return "ignore-stale-room";
  }
  return input.passiveMediaRequired || input.audioSessionJoined || input.hasPhysicalConsumer
    ? "keep-room"
    : "schedule-disconnect";
}
