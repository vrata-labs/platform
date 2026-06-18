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
    inputSources: XRInputSource[];
    profile: string;
    sanitizedAxes: XrAxesSample;
    rawAxes: XrAxesSample;
    triggerPressed: boolean;
    rayVisibleLatched: boolean;
  };
}
