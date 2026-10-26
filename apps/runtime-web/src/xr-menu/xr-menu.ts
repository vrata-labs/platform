import type { RuntimeFrameContext } from "../input/runtime-frame-context.js";
import type { MessageKey } from "../i18n/i18n.js";

// The menu a participant opens in the headset with B or Y: the microphone, back to the screen (the room stays) and
// leaving the space. It never moves the local pose; while it is open, locomotion gets no input.
export type XrMenuAction = "microphone" | "to_screen" | "leave" | "close";
export const XR_MENU_ACTIONS: readonly XrMenuAction[] = ["microphone", "to_screen", "leave", "close"];
export const XR_LEAVE_CONFIRM_MS = 4000;

export interface XrMenuState {
  open: boolean;
  leaveArmedUntilMs: number | null;
  menuPressedLastFrame: boolean;
}

export type XrMenuCommand = { type: "toggle_microphone" } | { type: "end_xr_session" } | { type: "leave_space" };

export interface XrMenuStepInput {
  presenting: boolean;
  menuPressed: boolean;
  confirm: boolean;
  hoveredAction: XrMenuAction | null;
  nowMs: number;
}

export interface XrMenuStep {
  state: XrMenuState;
  command: XrMenuCommand | null;
  opened: boolean;
}

export function createXrMenuState(): XrMenuState {
  return { open: false, leaveArmedUntilMs: null, menuPressedLastFrame: false };
}

/** One frame of the menu from one input sample. Leaving needs a second press within a few seconds. */
export function stepXrMenu(state: XrMenuState, input: XrMenuStepInput): XrMenuStep {
  if (!input.presenting) return { state: createXrMenuState(), command: null, opened: false };
  const toggled = input.menuPressed && !state.menuPressedLastFrame;
  let open = toggled ? !state.open : state.open;
  let leaveArmedUntilMs = open && state.leaveArmedUntilMs !== null && input.nowMs <= state.leaveArmedUntilMs ? state.leaveArmedUntilMs : null;
  let command: XrMenuCommand | null = null;
  if (open && !toggled && input.confirm && input.hoveredAction) {
    switch (input.hoveredAction) {
      case "close":
        open = false;
        break;
      case "to_screen":
        open = false;
        command = { type: "end_xr_session" };
        break;
      case "microphone":
        command = { type: "toggle_microphone" };
        break;
      case "leave":
        if (leaveArmedUntilMs !== null) {
          open = false;
          command = { type: "leave_space" };
        } else {
          leaveArmedUntilMs = input.nowMs + XR_LEAVE_CONFIRM_MS;
        }
        break;
    }
  }
  if (!open) leaveArmedUntilMs = null;
  return {
    state: { open, leaveArmedUntilMs, menuPressedLastFrame: input.menuPressed },
    command,
    opened: open && !state.open
  };
}

/**
 * Whether the menu takes this frame's input: it is open, or B/Y opens it right now. Decided before locomotion runs,
 * so a trigger or stick pressed together with B/Y on the opening frame is not a teleport or a turn.
 */
export function xrMenuOwnsFrame(state: XrMenuState, input: { presenting: boolean; menuPressed: boolean }): boolean {
  return input.presenting && (state.open || (input.menuPressed && !state.menuPressedLastFrame));
}

export interface XrMenuAudioState {
  available: boolean;
  joined: boolean;
  microphoneEnabled: boolean;
}

export function xrMenuButtonLabel(action: XrMenuAction, state: XrMenuState, audio: XrMenuAudioState): MessageKey {
  switch (action) {
    case "microphone":
      if (!audio.available) return "audio.unsupported";
      return audio.joined && audio.microphoneEnabled ? "audio.mute" : "audio.unmute";
    case "to_screen":
      return "leave.toScreen";
    case "leave":
      return state.leaveArmedUntilMs !== null ? "leave.confirm" : "leave.button";
    case "close":
      return "leave.close";
  }
}

/**
 * While the menu is open the same input sample drives the menu, so movement, turning, the aim ray and teleport rest.
 * The trigger state itself stays true to the sample: the press that closes the menu must not become a teleport next frame.
 */
export function withoutLocomotionInput(frameContext: RuntimeFrameContext): RuntimeFrameContext {
  return {
    ...frameContext,
    intents: { ...frameContext.intents, move: { x: 0, z: 0 }, snapTurn: { axis: 0 }, aimRay: false, confirmInteraction: false },
    ...(frameContext.xr ? { xr: { ...frameContext.xr, sanitizedAxes: { moveX: 0, moveY: 0, turnX: 0, turnY: 0 }, rayVisibleLatched: false } } : {})
  };
}
