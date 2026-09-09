import test from "node:test";
import assert from "node:assert/strict";

import {
  isEnabledEnvValue,
  isDevRoleQueryAllowed,
  isSpatialAudioFeatureEnabled,
  isXrFeatureEnabled,
  isRoomAccessPolicyEnabled,
  isNotesFeatureEnabled,
  isDocumentsFeatureEnabled,
  isPersonalRoomsFeatureEnabled,
  isRemoteBrowserFeatureEnabled,
  isSceneBundleUploadEnabled,
  isHostControlsEnabled
} from "./feature-flags.js";

const booleanCases: Array<[string | undefined, boolean | null]> = [
  [undefined, null], ["", null], [" \t\n", null], ["invalid", null], ["2", null],
  ["1", true], ["true", true], ["yes", true], ["on", true], [" TRUE ", true],
  ["0", false], ["false", false], ["no", false], ["off", false], [" OFF ", false]
];

for (const [value, expected] of booleanCases) {
  test(`boolean environment value ${JSON.stringify(value)} resolves to ${expected}`, () => {
    assert.equal(isEnabledEnvValue(value), expected);
  });
}

const aliasedFlags = [
  { resolve: isSpatialAudioFeatureEnabled, primary: "SPATIAL_AUDIO_ENABLED", fallback: "FEATURE_SPATIAL_AUDIO" },
  { resolve: isXrFeatureEnabled, primary: "XR_ENABLED", fallback: "FEATURE_XR" },
  { resolve: isRoomAccessPolicyEnabled, primary: "ROOM_ACCESS_POLICY_ENABLED", fallback: "FEATURE_ROOM_ACCESS_POLICY" },
  { resolve: isHostControlsEnabled, primary: "HOST_CONTROLS_ENABLED", fallback: "FEATURE_HOST_CONTROLS" }
];

for (const { resolve, primary, fallback } of aliasedFlags) {
  test(`${primary} preserves defaults, aliases and primary precedence`, () => {
    for (const nodeEnv of [undefined, "development", "production"]) {
      assert.equal(resolve({ NODE_ENV: nodeEnv }), true);
      for (const [primaryValue, primaryResult] of booleanCases) {
        for (const [fallbackValue, fallbackResult] of booleanCases) {
          const env = { NODE_ENV: nodeEnv, [primary]: primaryValue, [fallback]: fallbackValue };
          assert.equal(resolve(env), primaryResult ?? fallbackResult ?? true, JSON.stringify(env));
        }
      }
    }
  });
}

const simpleFlags = [
  { resolve: isNotesFeatureEnabled, key: "FEATURE_NOTES" },
  { resolve: isDocumentsFeatureEnabled, key: "FEATURE_DOCUMENTS" },
  { resolve: isPersonalRoomsFeatureEnabled, key: "FEATURE_PERSONAL_ROOMS" }
];

for (const { resolve, key } of simpleFlags) {
  test(`${key} preserves default-on and explicit boolean values`, () => {
    for (const nodeEnv of [undefined, "development", "production"]) {
      for (const [value, expected] of booleanCases) {
        assert.equal(resolve({ NODE_ENV: nodeEnv, [key]: value }), expected ?? true);
      }
    }
  });
}

test("remote browser and development roles default off only in exact production mode", () => {
  for (const nodeEnv of [undefined, "development", "test", "production", "Production", " production "]) {
    for (const [value, expected] of booleanCases) {
      assert.equal(isRemoteBrowserFeatureEnabled({ NODE_ENV: nodeEnv, REMOTE_BROWSER_ENABLED: value }), expected ?? nodeEnv !== "production");
      assert.equal(isDevRoleQueryAllowed({ NODE_ENV: nodeEnv, VRATA_DEV_ROLE_QUERY: value }), expected ?? nodeEnv !== "production");
    }
  }
});

test("development role aliases choose the first defined value before boolean parsing", () => {
  // Empty and invalid primary values intentionally block later aliases.
  for (const nodeEnv of ["development", "production"]) {
    for (const [current, currentResult] of booleanCases) {
      for (const [legacy, legacyResult] of booleanCases) {
        for (const [feature, featureResult] of booleanCases) {
          const selected = current !== undefined ? currentResult : legacy !== undefined ? legacyResult : featureResult;
          const env = { NODE_ENV: nodeEnv, VRATA_DEV_ROLE_QUERY: current, NOAH_DEV_ROLE_QUERY: legacy, FEATURE_DEV_ROLE_QUERY: feature };
          assert.equal(isDevRoleQueryAllowed(env), selected ?? nodeEnv !== "production", JSON.stringify(env));
        }
      }
    }
  }
});

test("scene bundle master switch preserves its exact lowercase false condition", () => {
  for (const master of [undefined, "", "false", " false ", "FALSE", "0", "off", "true"]) {
    for (const [upload, expected] of booleanCases) {
      const env = { FEATURE_SCENE_BUNDLES: master, FEATURE_SCENE_BUNDLE_UPLOAD: upload };
      assert.equal(isSceneBundleUploadEnabled(env), master === "false" ? false : expected ?? true, JSON.stringify(env));
    }
  }
});

test("flag resolvers do not mutate the supplied environment", () => {
  const env = Object.freeze({ NODE_ENV: "production", FEATURE_NOTES: "false", VRATA_DEV_ROLE_QUERY: "true" });
  for (const resolve of [
    ...aliasedFlags.map((flag) => flag.resolve), ...simpleFlags.map((flag) => flag.resolve),
    isDevRoleQueryAllowed, isRemoteBrowserFeatureEnabled, isSceneBundleUploadEnabled
  ]) {
    assert.doesNotThrow(() => resolve(env));
  }
  assert.deepEqual(env, { NODE_ENV: "production", FEATURE_NOTES: "false", VRATA_DEV_ROLE_QUERY: "true" });
});

test("omitted environment is read at each call rather than captured at import", () => {
  const flags = [
    ...aliasedFlags.map(({ resolve, primary }) => ({ resolve, key: primary })),
    ...simpleFlags,
    { resolve: isDevRoleQueryAllowed, key: "VRATA_DEV_ROLE_QUERY" },
    { resolve: isRemoteBrowserFeatureEnabled, key: "REMOTE_BROWSER_ENABLED" },
    { resolve: isSceneBundleUploadEnabled, key: "FEATURE_SCENE_BUNDLE_UPLOAD" }
  ];
  const keys = [
    "NODE_ENV", "FEATURE_SCENE_BUNDLES", "NOAH_DEV_ROLE_QUERY", "FEATURE_DEV_ROLE_QUERY",
    ...aliasedFlags.map(({ fallback }) => fallback), ...flags.map(({ key }) => key)
  ];
  const saved = new Map(keys.map((key) => [key, process.env[key]]));
  try {
    for (const key of keys) delete process.env[key];
    process.env.NODE_ENV = "production";
    for (const { resolve, key } of flags) {
      process.env[key] = "false";
      assert.equal(resolve(), false, key);
      process.env[key] = "true";
      assert.equal(resolve(), true, key);
      delete process.env[key];
    }
    assert.equal(isRemoteBrowserFeatureEnabled(), false);
    assert.equal(isDevRoleQueryAllowed(), false);
    process.env.NODE_ENV = "development";
    assert.equal(isRemoteBrowserFeatureEnabled(), true);
    assert.equal(isDevRoleQueryAllowed(), true);
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
