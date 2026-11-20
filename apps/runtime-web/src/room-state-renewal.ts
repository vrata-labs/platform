/** A routine token refresh can wait to replace its socket, but cannot extend
 * the old credential or lend it to a later media transition. */
export function createRoomStateRenewalCutover<Connection extends object, Transition extends object>(input: {
  current(): { connection: Connection | null; transition: Transition | null; authority: string | null };
  replace(connection: Connection): void;
  now(): number;
  schedule(run: () => void, delayMs: number): () => void;
}) {
  let pending: { connection: Connection; transition: Transition; authority: string; deadlineMs: number; cancel: () => void } | null = null;

  function clear(): Connection | null {
    const previous = pending;
    pending = null;
    previous?.cancel();
    return previous?.connection ?? null;
  }

  function sync(): void {
    if (!pending) return;
    const { connection, transition, authority } = input.current();
    if (connection !== pending.connection) { clear(); return; }
    if (transition !== pending.transition || authority !== pending.authority || expired()) {
      clear();
      input.replace(connection);
    }
  }

  function expired(): boolean {
    return pending !== null && !(input.now() < pending.deadlineMs);
  }

  function request(connection: Connection, unchangedAuthority: boolean, deadlineMs: number | null): void {
    const state = input.current();
    if (state.connection !== connection) return;
    const remainingMs = deadlineMs === null ? 0 : deadlineMs - input.now();
    if (!unchangedAuthority || state.authority === null || !state.transition || deadlineMs === null
      || !Number.isFinite(remainingMs) || remainingMs <= 0) {
      clear();
      input.replace(connection);
      return;
    }
    // A second refresh on the same socket cannot extend the first wait.
    if (pending?.connection === connection) { sync(); return; }
    clear();
    const hold = { connection, transition: state.transition, authority: state.authority,
      deadlineMs, cancel: () => {} };
    pending = hold;
    hold.cancel = input.schedule(() => {
      if (pending !== hold) return;
      clear();
      if (input.current().connection === connection) input.replace(connection);
    }, Math.floor(remainingMs));
  }

  return { request, sync, clear, expired };
}
