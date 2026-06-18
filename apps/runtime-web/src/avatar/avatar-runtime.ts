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
    avatarSeatingEnabled: true,
    avatarCustomizationEnabled: false,
    avatarFallbackCapsulesEnabled: true
  };
}

export function resolveAvatarRuntimeFlags(boot: RuntimeBootResult): AvatarRuntimeFlags {
  return {
    avatarsEnabled: boot.envFlags.avatarsEnabled && boot.avatarConfig.avatarsEnabled,
    avatarPoseBinaryEnabled: boot.envFlags.avatarPoseBinaryEnabled && boot.avatarConfig.avatarPoseBinaryEnabled,
    avatarLipsyncEnabled: boot.envFlags.avatarLipsyncEnabled && boot.avatarConfig.avatarLipsyncEnabled,
    avatarLegIkEnabled: boot.envFlags.avatarLegIkEnabled && boot.avatarConfig.avatarLegIkEnabled,
    avatarSeatingEnabled: boot.envFlags.avatarSeatingEnabled && boot.avatarConfig.avatarSeatsEnabled,
    avatarCustomizationEnabled: boot.envFlags.avatarCustomizationEnabled && boot.avatarConfig.avatarCustomizationEnabled,
    avatarFallbackCapsulesEnabled: boot.envFlags.avatarFallbackCapsulesEnabled && boot.avatarConfig.avatarFallbackCapsulesEnabled
  };
}

export function resolveAvatarCatalogUrl(boot: RuntimeBootResult): string {
  return boot.avatarConfig.avatarCatalogUrl ?? "/assets/avatars/catalog.v1.json";
}
