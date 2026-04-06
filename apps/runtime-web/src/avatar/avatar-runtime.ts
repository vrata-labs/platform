import type { RuntimeBootResult } from "../index.js";

export interface AvatarRuntimeFlags {
  avatarsEnabled: boolean;
  avatarPoseBinaryEnabled: boolean;
  avatarLipsyncEnabled: boolean;
  avatarLegIkEnabled: boolean;
  avatarSeatingEnabled: boolean;
  avatarCustomizationEnabled: boolean;
  avatarFallbackCapsulesEnabled: boolean;
}

export interface AvatarRuntimeFlagOverrides {
  avatarLegIkEnabled?: boolean;
}

export function createInitialAvatarRuntimeFlags(): AvatarRuntimeFlags {
  return {
    avatarsEnabled: true,
    avatarPoseBinaryEnabled: true,
    avatarLipsyncEnabled: false,
    avatarLegIkEnabled: false,
    avatarSeatingEnabled: false,
    avatarCustomizationEnabled: false,
    avatarFallbackCapsulesEnabled: true
  };
}

export function resolveAvatarRuntimeFlags(boot: RuntimeBootResult): AvatarRuntimeFlags {
  return {
    avatarsEnabled: boot.envFlags.avatarsEnabled && boot.avatarConfig.avatarsEnabled,
    avatarPoseBinaryEnabled: boot.envFlags.avatarPoseBinaryEnabled,
    avatarLipsyncEnabled: boot.envFlags.avatarLipsyncEnabled,
    avatarLegIkEnabled: boot.envFlags.avatarLegIkEnabled,
    avatarSeatingEnabled: boot.envFlags.avatarSeatingEnabled,
    avatarCustomizationEnabled: boot.envFlags.avatarCustomizationEnabled,
    avatarFallbackCapsulesEnabled: boot.envFlags.avatarFallbackCapsulesEnabled && boot.avatarConfig.avatarFallbackCapsulesEnabled
  };
}

export function resolveAvatarRuntimeFlagOverrides(query: URLSearchParams): AvatarRuntimeFlagOverrides {
  const avatarLegIk = query.get("avatarik") ?? query.get("avatarLegIk");
  if (avatarLegIk === "1" || avatarLegIk === "true") {
    return { avatarLegIkEnabled: true };
  }
  if (avatarLegIk === "0" || avatarLegIk === "false") {
    return { avatarLegIkEnabled: false };
  }
  return {};
}

export function applyAvatarRuntimeFlagOverrides(
  flags: AvatarRuntimeFlags,
  overrides: AvatarRuntimeFlagOverrides
): AvatarRuntimeFlags {
  return {
    ...flags,
    ...overrides
  };
}

export function resolveAvatarCatalogUrl(boot: RuntimeBootResult): string {
  return boot.avatarConfig.avatarCatalogUrl ?? "/assets/avatars/catalog.v1.json";
}
