export interface XrSupport {
  available: boolean;
  canEnterVr: boolean;
}

export function detectXrSupport(input: { navigatorXr?: unknown; immersiveVrSupported?: boolean }): XrSupport {
  const available = Boolean(input.navigatorXr);
  return {
    available,
    canEnterVr: available && Boolean(input.immersiveVrSupported)
  };
}

export function getEnterVrVisibility(support: XrSupport, featureEnabled: boolean): boolean {
  return featureEnabled && support.canEnterVr;
}
