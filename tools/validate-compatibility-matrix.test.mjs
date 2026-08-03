import assert from "node:assert/strict";
import test from "node:test";

import {
  loadCompatibilityMatrix,
  renderCompatibilityMarkdown,
  validateCompatibilityMatrix
} from "./validate-compatibility-matrix.mjs";

const rootDir = new URL("..", import.meta.url).pathname.replace(/\/$/, "");

async function validMatrix() {
  return structuredClone(await loadCompatibilityMatrix(rootDir));
}

function errorCodes(errors) {
  return errors.map((error) => error.code);
}

test("compatibility matrix baseline is valid", async () => {
  const matrix = await validMatrix();
  assert.deepEqual(validateCompatibilityMatrix(matrix, { rootDir }), []);
});

test("compatibility matrix rejects unknown status and invalid date", async () => {
  const matrix = await validMatrix();
  matrix.profiles[1].lastReviewed = "2026-02-30";
  matrix.profiles[1].capabilities.join.status = "maybe";

  const codes = errorCodes(validateCompatibilityMatrix(matrix, { rootDir }));
  assert.ok(codes.includes("invalid_date"));
  assert.ok(codes.includes("invalid_status"));
});

test("supported capability requires qualifying evidence and test metadata", async () => {
  const matrix = await validMatrix();
  const profile = matrix.profiles.find((item) => item.id === "desktop-chromium-linux-ci");
  profile.capabilities.join.evidenceIds = [];
  profile.browserVersion = null;

  const codes = errorCodes(validateCompatibilityMatrix(matrix, { rootDir }));
  assert.ok(codes.includes("missing_qualifying_evidence"));
  assert.ok(codes.includes("missing_test_metadata"));
});

test("unsupported capability requires failed evidence or product decision", async () => {
  const matrix = await validMatrix();
  const profile = matrix.profiles.find((item) => item.id === "android-chrome");
  profile.capabilities.join.status = "unsupported";

  assert.ok(errorCodes(validateCompatibilityMatrix(matrix, { rootDir })).includes("missing_qualifying_evidence"));
});

test("untested profile cannot retain test metadata without qualifying evidence", async () => {
  const matrix = await validMatrix();
  const profile = matrix.profiles.find((item) => item.id === "android-chrome");
  profile.lastTested = "2026-08-02";
  profile.testedRevision = matrix.evidence[0].revision;

  assert.ok(errorCodes(validateCompatibilityMatrix(matrix, { rootDir })).includes("test_metadata_without_evidence"));
});

test("qualifying evidence must be linked and cannot leave a capability untested", async () => {
  const matrix = await validMatrix();
  const evidence = {
    ...matrix.evidence[0],
    id: "android-manual-join",
    type: "manual-device",
    profileIds: ["android-chrome"],
    capabilityIds: ["join"]
  };
  matrix.evidence.push(evidence);

  let codes = errorCodes(validateCompatibilityMatrix(matrix, { rootDir }));
  assert.ok(codes.includes("unlinked_evidence"));

  const profile = matrix.profiles.find((item) => item.id === "android-chrome");
  profile.capabilities.join.evidenceIds = [evidence.id];
  codes = errorCodes(validateCompatibilityMatrix(matrix, { rootDir }));
  assert.ok(codes.includes("untested_with_qualifying_evidence"));
});

test("failed real-device claim requires exact tested profile metadata", async () => {
  const matrix = await validMatrix();
  const profile = matrix.profiles.find((item) => item.id === "android-chrome");
  profile.capabilities.join.status = "unsupported";
  profile.capabilities.join.evidenceIds = ["android-failed-join"];
  matrix.evidence.push({
    ...matrix.evidence[0],
    id: "android-failed-join",
    type: "manual-device",
    outcome: "failed",
    profileIds: ["android-chrome"],
    capabilityIds: ["join"]
  });

  assert.ok(errorCodes(validateCompatibilityMatrix(matrix, { rootDir })).includes("missing_test_metadata"));
});

test("profile category is restricted to desktop, mobile, or vr", async () => {
  const matrix = await validMatrix();
  matrix.profiles[0].category = "tablet";

  assert.ok(errorCodes(validateCompatibilityMatrix(matrix, { rootDir })).includes("invalid_profile_category"));
});

test("emulation cannot qualify a physical mobile profile", async () => {
  const matrix = await validMatrix();
  const profile = matrix.profiles.find((item) => item.id === "android-chrome");
  profile.deviceVersion = "Pixel emulation";
  profile.osVersion = "Android 16 emulation";
  profile.browserVersion = "Chromium 145";
  profile.lastTested = "2026-08-02";
  profile.testedRevision = matrix.evidence[0].revision;
  profile.capabilities.join.status = "supported";
  profile.capabilities.join.evidenceIds = ["mobile-emulation"];
  matrix.evidence.push({
    ...matrix.evidence[0],
    id: "mobile-emulation",
    type: "emulation",
    profileIds: ["android-chrome"],
    capabilityIds: ["join"]
  });

  assert.ok(errorCodes(validateCompatibilityMatrix(matrix, { rootDir })).includes("missing_qualifying_evidence"));
});

test("degraded capability requires a known issue with workaround", async () => {
  const matrix = await validMatrix();
  const profile = matrix.profiles.find((item) => item.id === "desktop-chromium-linux-ci");
  profile.capabilities.join.status = "degraded";

  let codes = errorCodes(validateCompatibilityMatrix(matrix, { rootDir }));
  assert.ok(codes.includes("degraded_without_issue"));

  profile.capabilities.join.knownIssueIds = ["quest-motion-smoothness-history"];
  matrix.knownIssues[0].profileIds.push("desktop-chromium-linux-ci");
  matrix.knownIssues[0].capabilityIds.push("join");
  matrix.knownIssues[0].workaround = "";
  codes = errorCodes(validateCompatibilityMatrix(matrix, { rootDir }));
  assert.ok(codes.includes("required_string"));
});

test("markdown rendering is deterministic and escapes table separators", async () => {
  const matrix = await validMatrix();
  matrix.profiles[1].notes = "Literal <script> stays text | in generated docs.";
  const first = renderCompatibilityMarkdown(matrix);
  const second = renderCompatibilityMarkdown(matrix);

  assert.equal(first, second);
  assert.match(first, /supported/);
  assert.match(first, /Not tested/);
  assert.match(first, /Client compatibility/);
});
