export type PropHand = "left" | "right";
export interface PropPoint { x: number; y: number; z: number }
export interface PropGrip { pressed: boolean; position: PropPoint | null }

const hands = ["left", "right"] as const;
const distanceSquared = (a: PropPoint, b: PropPoint) =>
  (a.x - b.x) ** 2 + (a.y - b.y) ** 2 + (a.z - b.z) ** 2;

/** A rising grip near the handle can hold it; tracking loss or pulling past the tether releases it. */
export function createHeldPropState(pickupRadius: number, tetherLength: number) {
  let heldBy: PropHand | null = null;
  let pressed = { left: false, right: false };
  return {
    update(input: {
      enabled: boolean;
      grips: Readonly<Record<PropHand, PropGrip | null>>;
      restHandle: PropPoint;
      tetherAnchor: PropPoint;
    }) {
      const previous = pressed;
      const { grips, enabled, restHandle, tetherAnchor } = input;
      pressed = { left: grips.left?.pressed === true, right: grips.right?.pressed === true };
      const valid = (grip: PropGrip | null): grip is PropGrip & { position: PropPoint } =>
        grip?.pressed === true && grip.position !== null && distanceSquared(grip.position, tetherAnchor) <= tetherLength ** 2;
      if (!enabled) {
        heldBy = null;
      } else if (heldBy) {
        if (!valid(grips[heldBy])) heldBy = null;
      } else {
        let nearest = Infinity;
        for (const hand of hands) {
          const grip = grips[hand];
          if (previous[hand] || !valid(grip)) continue;
          const distance = distanceSquared(grip.position, restHandle);
          if (distance <= pickupRadius ** 2 && distance < nearest) {
            heldBy = hand;
            nearest = distance;
          }
        }
      }
      return heldBy;
    }
  };
}

/** Only the held tip approaching the head can emit; staying there repeats at the source cadence. */
export function createHeldPropContact(radius: number, intervalMs: number) {
  let touching = false;
  let nextPulseAt = -Infinity;
  return {
    update(nowMs: number, tip: PropPoint | null, head: PropPoint | null) {
      const wasTouching = touching;
      // A little separation on exit prevents rapid start/stop on the boundary as tracking jitters.
      const limit = radius * (touching ? 1.2 : 1);
      touching = !!tip && !!head && distanceSquared(tip, head) <= limit ** 2;
      const pulse = touching && nowMs >= nextPulseAt;
      if (pulse) nextPulseAt = nowMs + intervalMs;
      return { touching, pulse, stop: wasTouching && !touching };
    }
  };
}
