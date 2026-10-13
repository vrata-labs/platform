class MediaUpgradeCleanupError extends Error {
  constructor() { super("media_upgrade_cleanup_failed"); }
}

export function permitsScreenShare(permission: { canPublish?: boolean; canPublishSources?: readonly string[] } | undefined): boolean {
  if (!permission?.canPublish) return false;
  const sources = permission.canPublishSources;
  // LiveKit treats an absent/empty list as unrestricted, including legacy servers.
  return !sources?.length || sources.includes("screen_share") && sources.includes("screen_share_audio");
}

/** A promotion may require a new media connection. Prepare first, retire the old identity before connecting the new one,
 * and never deliver an invalidated connection. Normal Host sharing reuses the sources confirmed at initial connect. */
export function createMediaSourceUpgrade<Room, Plan>(options: {
  current: () => Room | null;
  ensureBase: () => Promise<Room>;
  permitsShare: (room: Room) => boolean;
  assertActive: () => void;
  prepare: (screenShare: boolean) => Promise<Plan>;
  create: () => Room;
  retire: (room: Room) => Promise<void>;
  connect: (room: Room, plan: Plan) => Promise<void>;
  install: (room: Room) => void;
  dispose: (room: Room) => Promise<void>;
  restoreMicrophone: (room: Room) => Promise<void>;
  transition: (active: boolean) => void;
  recoveryFailed: () => void;
  invalidatedError: () => Error;
}) {
  let generation = 0, pending: Promise<Room> | null = null;
  const assertActive = (ticket: number) => {
    options.assertActive();
    if (generation !== ticket) throw options.invalidatedError();
  };
  const connect = async (plan: Plan, ticket: number, requireShare: boolean): Promise<Room> => {
    assertActive(ticket);
    const room = options.create();
    try {
      await options.connect(room, plan);
      assertActive(ticket);
      if (requireShare && !options.permitsShare(room)) throw new Error("screen_share_source_not_granted");
      options.install(room);
      await options.restoreMicrophone(room);
      assertActive(ticket);
      return room;
    } catch (error) {
      // Cleanup must complete before another same-identity connection is attempted.
      try { await options.dispose(room); }
      catch { throw new MediaUpgradeCleanupError(); }
      throw error;
    }
  };
  const upgrade = async (old: Room, ticket: number): Promise<Room> => {
    let retired = false;
    options.transition(true);
    try {
      const plan = await options.prepare(true);
      assertActive(ticket);
      if (options.current() !== old) throw options.invalidatedError();
      await options.retire(old);
      retired = true;
      assertActive(ticket);
      return await connect(plan, ticket, true);
    } catch (error) {
      if (retired && generation === ticket && !(error instanceof MediaUpgradeCleanupError)) {
        try {
          assertActive(ticket);
          // One fresh microphone-only recovery. The requested share still fails; it is never retried here.
          const plan = await options.prepare(false);
          assertActive(ticket);
          await connect(plan, ticket, false);
        } catch { options.recoveryFailed(); }
      } else if (retired || !options.current()) options.recoveryFailed();
      throw error;
    } finally { options.transition(false); }
  };
  const wait = async (request: Promise<Room>, screenShare: boolean): Promise<Room> => {
    try { return await request; }
    catch (error) {
      options.assertActive();
      const current = options.current();
      if (!screenShare && current) return current;
      throw error;
    }
  };
  return {
    async ensure(screenShare = false): Promise<Room> {
      if (pending) return wait(pending, screenShare);
      options.assertActive();
      const room = await options.ensureBase();
      options.assertActive();
      if (pending) return wait(pending, screenShare);
      if (!screenShare || options.permitsShare(room)) return room;
      const ticket = generation;
      const request = upgrade(room, ticket);
      pending = request;
      try { return await request; }
      finally { if (pending === request) pending = null; }
    },
    invalidate() { generation += 1; },
    isTransitioning() { return pending !== null; }
  };
}
