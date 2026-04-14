export function resolveXrTurnInput(turnX: number, turnY: number): number {
  return Math.abs(turnX) >= Math.abs(turnY) ? turnX : 0;
}
