/** Frame tokens authenticate a socket only at upgrade. Close that socket when
 * its proof expires; the viewer must obtain a new token from the API to resume. */
export function attachFrameTokenLease(input: {
  expiresAtSeconds: number;
  close: (code: number, reason: string) => void;
  onClose: (callback: () => void) => void;
  now?: () => number;
  schedule?: (callback: () => void, delayMs: number) => () => void;
}): { closeIfExpired: () => boolean } {
  const now = input.now ?? Date.now;
  const deadline = input.expiresAtSeconds * 1000;
  let expired = false;
  let disposed = false;
  const closeIfExpired = (): boolean => {
    if (expired || disposed) return true;
    if (now() < deadline) return false;
    expired = true;
    input.close(1008, "frame_token_expired");
    return true;
  };
  const schedule = input.schedule ?? ((callback: () => void, delayMs: number) => {
    const timer = setTimeout(callback, delayMs);
    return () => clearTimeout(timer);
  });
  let cancel: () => void = () => undefined;
  const checkDeadline = () => {
    if (!closeIfExpired()) cancel = schedule(checkDeadline, Math.max(1, deadline - now()));
  };
  cancel = schedule(checkDeadline, Math.max(0, deadline - now()));
  input.onClose(() => { disposed = true; cancel(); });
  return { closeIfExpired };
}
