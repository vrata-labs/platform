type Cleanup = () => unknown | Promise<unknown>;
type PrimaryFailure = { error: unknown };

/** Every owned resource gets an attempt; neither primary nor cleanup failures disappear. */
export async function cleanupAll(cleanups: Cleanup[], primary?: PrimaryFailure) {
  const errors: unknown[] = [];
  for (const cleanup of cleanups) {
    try { await cleanup(); } catch (error) { errors.push(error); }
  }
  if (errors.length) throw new AggregateError(primary ? [primary.error, ...errors] : errors,
    "owned_test_cleanup_failed", primary ? { cause: primary.error } : undefined);
}

export async function withCleanup<T>(run: () => Promise<T>, cleanups: () => Cleanup[]): Promise<T> {
  let primary: PrimaryFailure | undefined;
  try { return await run(); }
  catch (error) { primary = { error }; throw error; }
  finally { await cleanupAll(cleanups(), primary); }
}
