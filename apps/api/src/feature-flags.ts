export function isEnabledEnvValue(value: string | undefined): boolean | null {
  if (value === undefined || value.trim().length === 0) {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  return null;
}

export function isDevRoleQueryAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  const explicit = isEnabledEnvValue(env.VRATA_DEV_ROLE_QUERY ?? env.NOAH_DEV_ROLE_QUERY ?? env.FEATURE_DEV_ROLE_QUERY);
  if (explicit !== null) {
    return explicit;
  }
  return env.NODE_ENV !== "production";
}

export function isSpatialAudioFeatureEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const explicit = isEnabledEnvValue(env.SPATIAL_AUDIO_ENABLED);
  if (explicit !== null) {
    return explicit;
  }
  return isEnabledEnvValue(env.FEATURE_SPATIAL_AUDIO) ?? true;
}

export function isXrFeatureEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const explicit = isEnabledEnvValue(env.XR_ENABLED);
  if (explicit !== null) {
    return explicit;
  }
  return isEnabledEnvValue(env.FEATURE_XR) ?? true;
}

export function isRoomAccessPolicyEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const explicit = isEnabledEnvValue(env.ROOM_ACCESS_POLICY_ENABLED);
  if (explicit !== null) {
    return explicit;
  }
  return isEnabledEnvValue(env.FEATURE_ROOM_ACCESS_POLICY) ?? true;
}

export function isNotesFeatureEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return isEnabledEnvValue(env.FEATURE_NOTES) ?? true;
}

export function isDocumentsFeatureEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return isEnabledEnvValue(env.FEATURE_DOCUMENTS) ?? true;
}

export function isPersonalRoomsFeatureEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return isEnabledEnvValue(env.FEATURE_PERSONAL_ROOMS) ?? true;
}

export function isRemoteBrowserFeatureEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const configured = isEnabledEnvValue(env.REMOTE_BROWSER_ENABLED);
  return configured ?? env.NODE_ENV !== "production";
}

export function isSceneBundleUploadEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.FEATURE_SCENE_BUNDLES === "false") return false;
  return isEnabledEnvValue(env.FEATURE_SCENE_BUNDLE_UPLOAD) ?? true;
}

export function isHostControlsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const explicit = isEnabledEnvValue(env.HOST_CONTROLS_ENABLED);
  if (explicit !== null) {
    return explicit;
  }
  return isEnabledEnvValue(env.FEATURE_HOST_CONTROLS) ?? true;
}
