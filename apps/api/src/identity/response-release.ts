/** COMMIT can fail after synchronous response release. Account for the release
 * itself, not the later transaction completion, when reporting access outcome. */
export async function releaseFencedResponse(input: {
  run: (release: () => void) => Promise<void>;
  send: () => void;
  onReleased: () => void;
  onDenied: (error: unknown) => void;
}): Promise<void> {
  let released = false;
  try {
    await input.run(() => {
      input.send();
      released = true;
      input.onReleased();
    });
  } catch (error) {
    if (!released) input.onDenied(error);
    throw error;
  }
}
