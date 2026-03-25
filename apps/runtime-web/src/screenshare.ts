export interface ScreenShareSessionPlan {
  roomId: string;
  enabled: boolean;
  surfaceId: string;
}

export function createScreenShareSessionPlan(roomId: string, enabled: boolean): ScreenShareSessionPlan {
  return {
    roomId,
    enabled,
    surfaceId: "main-screen"
  };
}
