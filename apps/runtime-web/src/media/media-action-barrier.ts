/** A source upgrade waits for an audio action already using the old room. New UI actions are blocked by the transition;
 * the admitted action must be able to finish on the base room, rather than wait for its own replacement. */
export function createMediaActionBarrier() {
  let pending: Promise<void> | null = null;
  return {
    async run(action: () => Promise<void>): Promise<void> {
      if (pending) throw new Error("media_audio_action_overlaps");
      const request = Promise.resolve().then(action);
      const settled = request.then(() => undefined, () => undefined);
      pending = settled;
      try { await request; }
      finally { if (pending === settled) pending = null; }
    },
    settled(): Promise<void> { return pending ?? Promise.resolve(); }
  };
}
