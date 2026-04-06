import test from "node:test";
import assert from "node:assert/strict";

import { createInitialAvatarRuntimeFlags, resolveAvatarCatalogUrl, resolveAvatarRuntimeFlags } from "./avatar-runtime.js";

test("createInitialAvatarRuntimeFlags returns avatar-enabled defaults", () => {
  assert.deepEqual(createInitialAvatarRuntimeFlags(), {
    avatarsEnabled: true,
    avatarPoseBinaryEnabled: true,
    avatarLipsyncEnabled: false,
    avatarLegIkEnabled: false,
    avatarSeatingEnabled: false,
    avatarCustomizationEnabled: false,
    avatarFallbackCapsulesEnabled: true
  });
});

test("resolveAvatarRuntimeFlags combines env and manifest gates", () => {
  const boot = {
    avatarConfig: {
      avatarsEnabled: true,
      avatarCatalogUrl: "/assets/avatars/catalog.v1.json",
      avatarQualityProfile: "xr",
      avatarPoseBinaryEnabled: false,
      avatarLipsyncEnabled: false,
      avatarLegIkEnabled: false,
      avatarFallbackCapsulesEnabled: true,
      avatarSeatsEnabled: false,
      avatarCustomizationEnabled: false
    },
    envFlags: {
      enterVr: true,
      audioJoin: true,
      screenShare: true,
      roomStateRealtime: true,
      remoteDiagnostics: true,
      sceneBundles: true,
      avatarsEnabled: true,
      avatarPoseBinaryEnabled: true,
      avatarLipsyncEnabled: false,
      avatarLegIkEnabled: true,
      avatarSeatingEnabled: false,
      avatarCustomizationEnabled: true,
      avatarFallbackCapsulesEnabled: true
    }
  } as const;

  assert.deepEqual(resolveAvatarRuntimeFlags(boot as never), {
    avatarsEnabled: true,
    avatarPoseBinaryEnabled: true,
    avatarLipsyncEnabled: false,
    avatarLegIkEnabled: true,
    avatarSeatingEnabled: false,
    avatarCustomizationEnabled: true,
    avatarFallbackCapsulesEnabled: true
  });
});

test("resolveAvatarCatalogUrl falls back to default asset path", () => {
  const boot = {
    avatarConfig: {
      avatarCatalogUrl: undefined
    }
  } as const;

  assert.equal(resolveAvatarCatalogUrl(boot as never), "/assets/avatars/catalog.v1.json");
});
