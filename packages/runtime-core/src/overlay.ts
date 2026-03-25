export interface OverlayState {
  canJoinAudio: boolean;
  canEnterVr: boolean;
  connectionLabel: string;
}

export function createOverlayState(canEnterVr: boolean): OverlayState {
  return {
    canJoinAudio: true,
    canEnterVr,
    connectionLabel: "idle"
  };
}
