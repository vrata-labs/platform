export function isXrInteractionRayActive(turnY: number, deadzone = 0.75): boolean {
  return Math.abs(turnY) >= deadzone;
}

export function resolveXrTurnInput(turnX: number, turnY: number): number {
  return Math.abs(turnX) >= Math.abs(turnY) ? turnX : 0;
}
