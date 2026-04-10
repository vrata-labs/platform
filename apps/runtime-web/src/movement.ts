export interface FlatVector {
  x: number;
  z: number;
}

export interface XrAxesSample {
  moveX: number;
  moveY: number;
  turnX: number;
  turnY: number;
}

export interface XrTurnState {
  angle: number;
  cooldownSeconds: number;
}

const DEFAULT_ROOM_POSITION_LIMIT = 24;

export function applyDeadzone(value: number, deadzone = 0.18): number {
  return Math.abs(value) < deadzone ? 0 : value;
}

export function clampRoomPosition(position: FlatVector, limit = DEFAULT_ROOM_POSITION_LIMIT): FlatVector {
  return {
    x: Math.max(-limit, Math.min(limit, position.x)),
    z: Math.max(-limit, Math.min(limit, position.z))
  };
}

export function computeKeyboardDirection(keys: Record<string, boolean>): FlatVector {
  let x = 0;
  let z = 0;

  if (keys.KeyW || keys.ArrowUp) {
    z -= 1;
  }
  if (keys.KeyS || keys.ArrowDown) {
    z += 1;
  }
  if (keys.KeyA || keys.ArrowLeft) {
    x -= 1;
  }
  if (keys.KeyD || keys.ArrowRight) {
    x += 1;
  }

  return { x, z };
}

export function normalizeFlatVector(vector: FlatVector): FlatVector {
  const length = Math.hypot(vector.x, vector.z);
  if (length === 0) {
    return vector;
  }

  return {
    x: vector.x / length,
    z: vector.z / length
  };
}

export function rotateFlatVector(vector: FlatVector, yaw: number): FlatVector {
  const cos = Math.cos(yaw);
  const sin = Math.sin(yaw);

  return {
    x: vector.x * cos - vector.z * sin,
    z: vector.x * sin + vector.z * cos
  };
}

export function projectMovementToWorld(direction: FlatVector, flatForward: FlatVector): FlatVector {
  const normalizedForward = normalizeFlatVector(flatForward);
  if (normalizedForward.x === 0 && normalizedForward.z === 0) {
    return direction;
  }

  const right = {
    x: -normalizedForward.z,
    z: normalizedForward.x
  };

  return {
    x: right.x * direction.x + normalizedForward.x * -direction.z,
    z: right.z * direction.x + normalizedForward.z * -direction.z
  };
}

export function stepFlatMovement(position: FlatVector, direction: FlatVector, speed: number, delta: number): FlatVector {
  const normalized = normalizeFlatVector(direction);
  return clampRoomPosition({
    x: position.x + normalized.x * speed * delta,
    z: position.z + normalized.z * speed * delta
  });
}

export function applySnapTurn(state: XrTurnState, turnX: number, delta: number): XrTurnState {
  const nextCooldown = Math.max(0, state.cooldownSeconds - delta);
  const threshold = 0.7;
  if (Math.abs(turnX) < threshold || nextCooldown > 0) {
    return {
      angle: state.angle,
      cooldownSeconds: nextCooldown
    };
  }

  const snapAngle = Math.PI / 6;
  return {
    angle: state.angle + Math.sign(turnX) * snapAngle,
    cooldownSeconds: 0.28
  };
}

export function sanitizeXrAxes(sample: XrAxesSample): XrAxesSample {
  return {
    moveX: applyDeadzone(sample.moveX),
    moveY: applyDeadzone(sample.moveY),
    turnX: applyDeadzone(sample.turnX),
    turnY: applyDeadzone(sample.turnY)
  };
}
