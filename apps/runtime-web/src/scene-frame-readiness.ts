/**
 * A bundle is loaded before its first render: WebGL can still create programs
 * and upload textures synchronously in that frame. Only admit deadline-bound
 * room plugins after that work, without making room boot await animation.
 */
export function createSceneFrameReadiness(clock = () => performance.now()) {
  let awaitingFrame = false;
  let firstFrameAtMs: number | null = null;
  return {
    sceneAttached() {
      awaitingFrame = true;
      firstFrameAtMs = null;
    },
    get ready() { return !awaitingFrame; },
    get firstFrameAtMs() { return firstFrameAtMs; },
    // Call only after the active scene's renderer returned.
    frameRendered(contextLost: boolean): boolean {
      if (!awaitingFrame || contextLost) return false;
      firstFrameAtMs = clock();
      awaitingFrame = false;
      return true;
    }
  };
}
