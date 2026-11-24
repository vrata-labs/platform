import type { XrAxesSample } from "../movement.js";
import type { InputIntents } from "./input-intents.js";

export type RuntimeFrameSource = "desktop" | "xr" | "touch";

export interface RuntimeFrameContext {
  deltaSeconds: number;
  nowMs: number;
  source: RuntimeFrameSource;
  intents: InputIntents;
  xr?: {
    frame?: XRFrame;
    session?: XRSession;
    referenceSpace: XRReferenceSpace | null;
    viewerTransform?: XRRigidTransform | null;
    inputSources: XRInputSource[];
    profile: string;
    sanitizedAxes: XrAxesSample;
    rawAxes: XrAxesSample;
    triggerPressed: boolean;
    /** Squeeze is distinct from the ray trigger; use the frame's sample for scene props. */
    gripPressed?: { left: boolean; right: boolean };
    /** B or Y on either controller: opens and closes the XR menu. */
    menuPressed?: boolean;
    rayVisibleLatched: boolean;
  };
}
