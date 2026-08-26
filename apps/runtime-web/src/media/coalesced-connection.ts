export interface CoalescedConnection<T> {
  ensure(): Promise<T>;
  hasInFlight(): boolean;
  invalidate(): void;
}

export function createCoalescedConnection<T>(options: {
  create: () => T;
  connect: (resource: T) => Promise<void>;
  cleanupFailed: (resource: T) => Promise<void> | void;
  createInvalidatedError?: () => Error;
}): CoalescedConnection<T> {
  let generation = 0;
  let inFlightToken: object | null = null;
  let inFlightPromise: Promise<T> | null = null;

  return {
    ensure(): Promise<T> {
      if (inFlightPromise) {
        return inFlightPromise;
      }
      const resource = options.create();
      const token = {};
      const connectionGeneration = generation;
      const promise = (async () => {
        let cleaned = false;
        try {
          await options.connect(resource);
          if (connectionGeneration !== generation) {
            try {
              await options.cleanupFailed(resource);
            } catch {
              // Preserve invalidation as the failure reason.
            }
            cleaned = true;
            throw options.createInvalidatedError?.() ?? new Error("connection_invalidated");
          }
          return resource;
        } catch (error) {
          if (!cleaned) {
            try {
              await options.cleanupFailed(resource);
            } catch {
              // Preserve the connection failure while still attempting cleanup.
            }
          }
          throw error;
        } finally {
          if (inFlightToken === token) {
            inFlightToken = null;
            inFlightPromise = null;
          }
        }
      })();
      inFlightToken = token;
      inFlightPromise = promise;
      return promise;
    },
    hasInFlight(): boolean {
      return inFlightPromise !== null;
    },
    invalidate(): void {
      generation += 1;
    }
  };
}
