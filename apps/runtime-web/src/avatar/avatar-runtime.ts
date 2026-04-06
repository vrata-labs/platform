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

export function resolveAvatarCatalogUrl(boot: RuntimeBootResult): string {
  return boot.avatarConfig.avatarCatalogUrl ?? "/assets/avatars/catalog.v1.json";
}
