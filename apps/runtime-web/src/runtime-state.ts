import type { RuntimeIssueCode, RuntimeIssueSeverity } from "./runtime-errors.js";

export interface RuntimeUiState {
  statusLine: string;
  audioState: string;
  roomStateMode: string;
  issueCode: RuntimeIssueCode | null;
  issueSeverity: RuntimeIssueSeverity | null;
  degradedMode: string;
  retryCount: number;
  lastRecoveryAction: string;
}

export function createRuntimeUiState(): RuntimeUiState {
  return {
    statusLine: "Connecting...",
    audioState: "idle",
    roomStateMode: "connecting",
    issueCode: null,
    issueSeverity: null,
    degradedMode: "none",
    retryCount: 0,
    lastRecoveryAction: "none"
  };
}

export function applyRuntimeIssueState(
  state: RuntimeUiState,
  input: {
    statusLine: string;
    issueCode: RuntimeIssueCode;
    issueSeverity: RuntimeIssueSeverity;
    degradedMode: string;
    audioState?: string;
    roomStateMode?: string;
    lastRecoveryAction: string;
    incrementRetry?: boolean;
  }
): RuntimeUiState {
  return {
    ...state,
    statusLine: input.statusLine,
    audioState: input.audioState ?? state.audioState,
    roomStateMode: input.roomStateMode ?? state.roomStateMode,
    issueCode: input.issueCode,
    issueSeverity: input.issueSeverity,
    degradedMode: input.degradedMode,
    retryCount: state.retryCount + (input.incrementRetry ? 1 : 0),
    lastRecoveryAction: input.lastRecoveryAction
  };
}

export function clearRuntimeIssueState(state: RuntimeUiState, statusLine: string): RuntimeUiState {
  return {
    ...state,
    statusLine,
    issueCode: null,
    issueSeverity: null,
    degradedMode: "none",
    lastRecoveryAction: "cleared"
  };
}
