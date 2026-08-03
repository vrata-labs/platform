import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const CAPABILITY_IDS = ["join", "movement", "voice", "spatialAudio", "screenShare", "presentation", "webXr"];
export const PROFILE_IDS = ["desktop-chromium-linux-ci", "android-chrome", "ios-safari", "meta-quest-browser"];
export const STATUS_VALUES = ["supported", "degraded", "unsupported", "untested"];
export const EVIDENCE_TYPES = ["automated", "emulation", "manual-device", "product-decision"];
export const EVIDENCE_OUTCOMES = ["passed", "failed", "decision", "informational"];
export const DEFAULT_MATRIX_PATH = "apps/runtime-web/src/compatibility-matrix.json";
export const DEFAULT_DOCS_PATH = "docs/compatibility.md";

const realDeviceProfiles = new Set(["android-chrome", "ios-safari", "meta-quest-browser"]);
const profileCategories = new Set(["desktop", "mobile", "vr"]);

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isNullableString(value) {
  return value === null || isNonEmptyString(value);
}

function isIsoDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}

function stringArray(value) {
  return Array.isArray(value) && value.every(isNonEmptyString);
}

function duplicateValues(values) {
  const seen = new Set();
  const duplicates = new Set();
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value);
    seen.add(value);
  }
  return [...duplicates];
}

function validateLocalPath(rootDir, value) {
  if (!isNonEmptyString(value) || isAbsolute(value)) return false;
  const resolved = resolve(rootDir, value);
  const rootRelative = relative(resolve(rootDir), resolved);
  return rootRelative !== "" && !rootRelative.startsWith("..") && !isAbsolute(rootRelative) && existsSync(resolved);
}

function validateUrl(value) {
  if (value === null || value === undefined) return true;
  if (!isNonEmptyString(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

function mapRecords(items) {
  return new Map((Array.isArray(items) ? items : []).filter(isRecord).map((item) => [item.id, item]));
}

function qualifyingEvidence(cellStatus, evidence, profileId) {
  if (!evidence) return false;
  if (cellStatus === "supported" || cellStatus === "degraded") {
    if (evidence.outcome !== "passed" || evidence.type === "emulation" || evidence.type === "product-decision") return false;
    return !realDeviceProfiles.has(profileId) || evidence.type === "manual-device";
  }
  if (cellStatus === "unsupported") {
    if (evidence.type === "product-decision") return evidence.outcome === "decision";
    if (evidence.outcome !== "failed" || evidence.type === "emulation") return false;
    return !realDeviceProfiles.has(profileId) || evidence.type === "manual-device";
  }
  return true;
}

function isClaimEvidence(evidence, profileId) {
  if (!evidence) return false;
  if (evidence.type === "product-decision") return evidence.outcome === "decision";
  if (!new Set(["passed", "failed"]).has(evidence.outcome) || evidence.type === "emulation") return false;
  return !realDeviceProfiles.has(profileId) || evidence.type === "manual-device";
}

export function validateCompatibilityMatrix(matrix, { rootDir = process.cwd() } = {}) {
  const errors = [];
  const add = (code, path, message) => errors.push({ code, path, message });
  if (!isRecord(matrix)) {
    add("matrix_not_object", "$", "matrix must be an object");
    return errors;
  }

  if (matrix.schemaVersion !== 1) add("invalid_schema_version", "schemaVersion", "schemaVersion must equal 1");
  for (const key of ["title", "reviewOwner"]) {
    if (!isNonEmptyString(matrix[key])) add("required_string", key, `${key} must be a non-empty string`);
  }
  if (!stringArray(matrix.assumptions) || matrix.assumptions.length === 0) {
    add("invalid_assumptions", "assumptions", "assumptions must be a non-empty string array");
  }

  if (!isRecord(matrix.statusDefinitions)) {
    add("invalid_status_definitions", "statusDefinitions", "statusDefinitions must be an object");
  } else {
    for (const status of STATUS_VALUES) {
      if (!isNonEmptyString(matrix.statusDefinitions[status])) {
        add("missing_status_definition", `statusDefinitions.${status}`, `${status} must have a definition`);
      }
    }
    for (const status of Object.keys(matrix.statusDefinitions)) {
      if (!STATUS_VALUES.includes(status)) add("unknown_status_definition", `statusDefinitions.${status}`, `unknown status ${status}`);
    }
  }

  if (!Array.isArray(matrix.capabilities)) {
    add("invalid_capabilities", "capabilities", "capabilities must be an array");
  }
  const capabilityItems = Array.isArray(matrix.capabilities) ? matrix.capabilities : [];
  const capabilityIds = capabilityItems.filter(isRecord).map((item) => item.id).filter(isNonEmptyString);
  for (const duplicate of duplicateValues(capabilityIds)) add("duplicate_capability", "capabilities", `duplicate capability ${duplicate}`);
  for (const id of CAPABILITY_IDS) {
    if (!capabilityIds.includes(id)) add("missing_capability", "capabilities", `missing capability ${id}`);
  }
  for (const id of capabilityIds) {
    if (!CAPABILITY_IDS.includes(id)) add("unknown_capability", "capabilities", `unknown capability ${id}`);
  }
  for (const [index, capability] of capabilityItems.entries()) {
    if (!isRecord(capability)) {
      add("invalid_capability", `capabilities[${index}]`, "capability must be an object");
      continue;
    }
    for (const key of ["id", "label", "passCriteria"]) {
      if (!isNonEmptyString(capability[key])) add("required_string", `capabilities[${index}].${key}`, `${key} must be a non-empty string`);
    }
  }

  if (!Array.isArray(matrix.evidence)) add("invalid_evidence", "evidence", "evidence must be an array");
  const evidenceItems = Array.isArray(matrix.evidence) ? matrix.evidence : [];
  const evidenceIds = evidenceItems.filter(isRecord).map((item) => item.id).filter(isNonEmptyString);
  for (const duplicate of duplicateValues(evidenceIds)) add("duplicate_evidence", "evidence", `duplicate evidence ${duplicate}`);
  for (const [index, evidence] of evidenceItems.entries()) {
    const path = `evidence[${index}]`;
    if (!isRecord(evidence)) {
      add("invalid_evidence_item", path, "evidence item must be an object");
      continue;
    }
    for (const key of ["id", "label", "revision", "notes"]) {
      if (!isNonEmptyString(evidence[key])) add("required_string", `${path}.${key}`, `${key} must be a non-empty string`);
    }
    if (!EVIDENCE_TYPES.includes(evidence.type)) add("invalid_evidence_type", `${path}.type`, `invalid evidence type ${String(evidence.type)}`);
    if (!EVIDENCE_OUTCOMES.includes(evidence.outcome)) add("invalid_evidence_outcome", `${path}.outcome`, `invalid evidence outcome ${String(evidence.outcome)}`);
    if (evidence.type === "product-decision" && evidence.outcome !== "decision") {
      add("invalid_product_decision", `${path}.outcome`, "product-decision evidence must use decision outcome");
    }
    if (!isIsoDate(evidence.date)) add("invalid_date", `${path}.date`, "evidence date must use YYYY-MM-DD");
    if (!stringArray(evidence.profileIds) || evidence.profileIds.length === 0) add("invalid_profile_refs", `${path}.profileIds`, "profileIds must be a non-empty string array");
    if (!stringArray(evidence.capabilityIds) || evidence.capabilityIds.length === 0) add("invalid_capability_refs", `${path}.capabilityIds`, "capabilityIds must be a non-empty string array");
    if (!validateUrl(evidence.url)) add("invalid_url", `${path}.url`, "url must be HTTP(S) when present");
    if (!stringArray(evidence.sourcePaths) || evidence.sourcePaths.length === 0) {
      add("invalid_source_paths", `${path}.sourcePaths`, "sourcePaths must be a non-empty string array");
    } else {
      for (const sourcePath of evidence.sourcePaths) {
        if (!validateLocalPath(rootDir, sourcePath)) add("invalid_source_path", `${path}.sourcePaths`, `missing or unsafe source path ${sourcePath}`);
      }
    }
  }

  if (!Array.isArray(matrix.knownIssues)) add("invalid_known_issues", "knownIssues", "knownIssues must be an array");
  const knownIssueItems = Array.isArray(matrix.knownIssues) ? matrix.knownIssues : [];
  const knownIssueIds = knownIssueItems.filter(isRecord).map((item) => item.id).filter(isNonEmptyString);
  for (const duplicate of duplicateValues(knownIssueIds)) add("duplicate_known_issue", "knownIssues", `duplicate known issue ${duplicate}`);
  for (const [index, issue] of knownIssueItems.entries()) {
    const path = `knownIssues[${index}]`;
    if (!isRecord(issue)) {
      add("invalid_known_issue", path, "known issue must be an object");
      continue;
    }
    for (const key of ["id", "summary", "workaround"]) {
      if (!isNonEmptyString(issue[key])) add("required_string", `${path}.${key}`, `${key} must be a non-empty string`);
    }
    if (!stringArray(issue.profileIds) || issue.profileIds.length === 0) add("invalid_profile_refs", `${path}.profileIds`, "profileIds must be a non-empty string array");
    if (!stringArray(issue.capabilityIds) || issue.capabilityIds.length === 0) add("invalid_capability_refs", `${path}.capabilityIds`, "capabilityIds must be a non-empty string array");
    if (!stringArray(issue.sourcePaths) || issue.sourcePaths.length === 0) {
      add("invalid_source_paths", `${path}.sourcePaths`, "sourcePaths must be a non-empty string array");
    } else {
      for (const sourcePath of issue.sourcePaths) {
        if (!validateLocalPath(rootDir, sourcePath)) add("invalid_source_path", `${path}.sourcePaths`, `missing or unsafe source path ${sourcePath}`);
      }
    }
  }

  if (!Array.isArray(matrix.profiles)) add("invalid_profiles", "profiles", "profiles must be an array");
  const profileItems = Array.isArray(matrix.profiles) ? matrix.profiles : [];
  const profileIds = profileItems.filter(isRecord).map((item) => item.id).filter(isNonEmptyString);
  for (const duplicate of duplicateValues(profileIds)) add("duplicate_profile", "profiles", `duplicate profile ${duplicate}`);
  for (const id of PROFILE_IDS) {
    if (!profileIds.includes(id)) add("missing_profile", "profiles", `missing profile ${id}`);
  }
  for (const id of profileIds) {
    if (!PROFILE_IDS.includes(id)) add("unknown_profile", "profiles", `unknown profile ${id}`);
  }

  const evidenceById = mapRecords(evidenceItems);
  const knownIssuesById = mapRecords(knownIssueItems);
  const profileById = mapRecords(profileItems);
  for (const evidence of evidenceItems.filter(isRecord)) {
    for (const profileId of Array.isArray(evidence.profileIds) ? evidence.profileIds : []) {
      for (const capabilityId of Array.isArray(evidence.capabilityIds) ? evidence.capabilityIds : []) {
        const cell = profileById.get(profileId)?.capabilities?.[capabilityId];
        if (cell && (!Array.isArray(cell.evidenceIds) || !cell.evidenceIds.includes(evidence.id))) {
          add("unlinked_evidence", `evidence.${evidence.id}`, `${profileId}/${capabilityId} does not reference this evidence`);
        }
      }
    }
  }
  for (const issue of knownIssueItems.filter(isRecord)) {
    for (const profileId of Array.isArray(issue.profileIds) ? issue.profileIds : []) {
      for (const capabilityId of Array.isArray(issue.capabilityIds) ? issue.capabilityIds : []) {
        const cell = profileById.get(profileId)?.capabilities?.[capabilityId];
        if (cell && (!Array.isArray(cell.knownIssueIds) || !cell.knownIssueIds.includes(issue.id))) {
          add("unlinked_known_issue", `knownIssues.${issue.id}`, `${profileId}/${capabilityId} does not reference this known issue`);
        }
      }
    }
  }
  for (const [index, profile] of profileItems.entries()) {
    const path = `profiles[${index}]`;
    if (!isRecord(profile)) {
      add("invalid_profile", path, "profile must be an object");
      continue;
    }
    for (const key of ["id", "category", "label", "device", "os", "browser", "notes"]) {
      if (!isNonEmptyString(profile[key])) add("required_string", `${path}.${key}`, `${key} must be a non-empty string`);
    }
    if (isNonEmptyString(profile.category) && !profileCategories.has(profile.category)) {
      add("invalid_profile_category", `${path}.category`, `invalid profile category ${profile.category}`);
    }
    for (const key of ["deviceVersion", "osVersion", "browserVersion", "lastTested", "testedRevision"]) {
      if (!isNullableString(profile[key])) add("invalid_nullable_string", `${path}.${key}`, `${key} must be null or a non-empty string`);
    }
    if (!isIsoDate(profile.lastReviewed)) add("invalid_date", `${path}.lastReviewed`, "lastReviewed must use YYYY-MM-DD");
    if (profile.lastTested !== null && !isIsoDate(profile.lastTested)) add("invalid_date", `${path}.lastTested`, "lastTested must be null or YYYY-MM-DD");
    if (isIsoDate(profile.lastReviewed) && isIsoDate(profile.lastTested) && profile.lastReviewed < profile.lastTested) {
      add("review_before_test", `${path}.lastReviewed`, "lastReviewed cannot predate lastTested");
    }
    if (!isRecord(profile.capabilities)) {
      add("invalid_profile_capabilities", `${path}.capabilities`, "profile capabilities must be an object");
      continue;
    }

    const profileCapabilityIds = Object.keys(profile.capabilities);
    for (const id of CAPABILITY_IDS) {
      if (!profileCapabilityIds.includes(id)) add("missing_profile_capability", `${path}.capabilities`, `missing capability ${id}`);
    }
    for (const id of profileCapabilityIds) {
      if (!CAPABILITY_IDS.includes(id)) add("unknown_profile_capability", `${path}.capabilities.${id}`, `unknown capability ${id}`);
    }

    const qualifyingTestEvidence = [];
    for (const capabilityId of CAPABILITY_IDS) {
      const cell = profile.capabilities[capabilityId];
      const cellPath = `${path}.capabilities.${capabilityId}`;
      if (!isRecord(cell)) {
        add("invalid_capability_status", cellPath, "capability status must be an object");
        continue;
      }
      if (!STATUS_VALUES.includes(cell.status)) add("invalid_status", `${cellPath}.status`, `invalid status ${String(cell.status)}`);
      if (!stringArray(cell.evidenceIds)) add("invalid_evidence_refs", `${cellPath}.evidenceIds`, "evidenceIds must be a string array");
      if (!stringArray(cell.knownIssueIds)) add("invalid_known_issue_refs", `${cellPath}.knownIssueIds`, "knownIssueIds must be a string array");

      const referencedEvidence = (Array.isArray(cell.evidenceIds) ? cell.evidenceIds : []).map((id) => evidenceById.get(id));
      for (const evidenceId of Array.isArray(cell.evidenceIds) ? cell.evidenceIds : []) {
        const evidence = evidenceById.get(evidenceId);
        if (!evidence) {
          add("unknown_evidence", `${cellPath}.evidenceIds`, `unknown evidence ${evidenceId}`);
          continue;
        }
        if (!evidence.profileIds?.includes(profile.id) || !evidence.capabilityIds?.includes(capabilityId)) {
          add("evidence_scope_mismatch", `${cellPath}.evidenceIds`, `${evidenceId} does not cover ${profile.id}/${capabilityId}`);
        }
      }
      for (const issueId of Array.isArray(cell.knownIssueIds) ? cell.knownIssueIds : []) {
        const issue = knownIssuesById.get(issueId);
        if (!issue) {
          add("unknown_known_issue", `${cellPath}.knownIssueIds`, `unknown known issue ${issueId}`);
          continue;
        }
        if (!issue.profileIds?.includes(profile.id) || !issue.capabilityIds?.includes(capabilityId)) {
          add("known_issue_scope_mismatch", `${cellPath}.knownIssueIds`, `${issueId} does not cover ${profile.id}/${capabilityId}`);
        }
      }

      if (cell.status !== "untested") {
        const qualifying = referencedEvidence.filter((evidence) => qualifyingEvidence(cell.status, evidence, profile.id));
        if (qualifying.length === 0) add("missing_qualifying_evidence", `${cellPath}.evidenceIds`, `${cell.status} requires qualifying evidence`);
        qualifyingTestEvidence.push(...qualifying.filter((evidence) => evidence.type !== "product-decision"));
      } else if (referencedEvidence.some((evidence) => isClaimEvidence(evidence, profile.id))) {
        add("untested_with_qualifying_evidence", `${cellPath}.evidenceIds`, "untested cannot reference qualifying passed, failed, or decision evidence");
      }
      if (cell.status === "degraded" && (!Array.isArray(cell.knownIssueIds) || cell.knownIssueIds.length === 0)) {
        add("degraded_without_issue", `${cellPath}.knownIssueIds`, "degraded requires a known issue");
      }
    }

    if (qualifyingTestEvidence.length > 0) {
      for (const key of ["deviceVersion", "osVersion", "browserVersion", "lastTested", "testedRevision"]) {
        if (!isNonEmptyString(profile[key])) add("missing_test_metadata", `${path}.${key}`, `${key} is required for tested capability claims`);
      }
    } else if (profile.lastTested !== null || profile.testedRevision !== null) {
      add("test_metadata_without_evidence", path, "lastTested and testedRevision must be null without qualifying test evidence");
    }
    const latestEvidenceDate = qualifyingTestEvidence.map((item) => item.date).filter(isIsoDate).sort().at(-1) ?? null;
    if (latestEvidenceDate !== null && profile.lastTested !== latestEvidenceDate) {
      add("stale_last_tested", `${path}.lastTested`, `lastTested must equal latest qualifying evidence date ${latestEvidenceDate}`);
    }
    if (latestEvidenceDate !== null) {
      const latestRevisions = qualifyingTestEvidence.filter((item) => item.date === latestEvidenceDate).map((item) => item.revision);
      if (!latestRevisions.includes(profile.testedRevision)) {
        add("tested_revision_mismatch", `${path}.testedRevision`, "testedRevision must match latest qualifying evidence");
      }
    }
  }

  const profileIdSet = new Set(profileIds);
  const capabilityIdSet = new Set(capabilityIds);
  for (const [index, item] of [...evidenceItems, ...knownIssueItems].entries()) {
    if (!isRecord(item)) continue;
    const collection = index < evidenceItems.length ? "evidence" : "knownIssues";
    for (const id of Array.isArray(item.profileIds) ? item.profileIds : []) {
      if (!profileIdSet.has(id)) add("unknown_profile_ref", `${collection}.${item.id}.profileIds`, `unknown profile ${id}`);
    }
    for (const id of Array.isArray(item.capabilityIds) ? item.capabilityIds : []) {
      if (!capabilityIdSet.has(id)) add("unknown_capability_ref", `${collection}.${item.id}.capabilityIds`, `unknown capability ${id}`);
    }
  }

  return errors;
}

function markdownCell(value) {
  return String(value).replaceAll("|", "\\|").replaceAll("\n", " ");
}

function statusCell(cell) {
  const references = [
    ...cell.evidenceIds.map((id) => `[evidence](#evidence-${id})`),
    ...cell.knownIssueIds.map((id) => `[issue](#issue-${id})`)
  ];
  return references.length > 0 ? `${cell.status} ${references.join(" ")}` : cell.status;
}

export function renderCompatibilityMarkdown(matrix) {
  const capabilityById = new Map(matrix.capabilities.map((capability) => [capability.id, capability]));
  const lines = [
    "# Client compatibility",
    "",
    "> Generated from `apps/runtime-web/src/compatibility-matrix.json`. Run `pnpm validate:compatibility -- --write-docs` to update this file.",
    "",
    "This matrix describes browser and device compatibility for Vrata when the relevant feature is enabled on a correctly configured HTTPS self-host. It is not an SLA.",
    "",
    `Review owner: **${matrix.reviewOwner}**.`,
    "",
    "## Statuses",
    "",
    "| Status | Meaning |",
    "|---|---|",
    ...STATUS_VALUES.map((status) => `| ${status} | ${markdownCell(matrix.statusDefinitions[status])} |`),
    "",
    "## Capability criteria",
    "",
    "| Capability | Passing result |",
    "|---|---|",
    ...CAPABILITY_IDS.map((id) => `| ${markdownCell(capabilityById.get(id).label)} | ${markdownCell(capabilityById.get(id).passCriteria)} |`),
    "",
    "## Matrix",
    "",
    `| Client | Environment | ${CAPABILITY_IDS.map((id) => markdownCell(capabilityById.get(id).label)).join(" | ")} | Last reviewed | Last tested |`,
    `|---|---|${CAPABILITY_IDS.map(() => "---|").join("")}---|---|`,
    ...matrix.profiles.map((profile) => {
      const environment = `${profile.device}${profile.deviceVersion ? ` ${profile.deviceVersion}` : ""}; ${profile.os}${profile.osVersion ? ` ${profile.osVersion}` : ""}; ${profile.browser}${profile.browserVersion ? ` ${profile.browserVersion}` : ""}`;
      const statuses = CAPABILITY_IDS.map((id) => markdownCell(statusCell(profile.capabilities[id]))).join(" | ");
      return `| ${markdownCell(profile.label)} | ${markdownCell(environment)} | ${statuses} | ${profile.lastReviewed} | ${profile.lastTested ?? "Not tested"} |`;
    }),
    "",
    "## Assumptions",
    "",
    ...matrix.assumptions.map((assumption) => `- ${assumption}`),
    "",
    "## Profile notes",
    "",
    ...matrix.profiles.flatMap((profile) => [
      `### ${profile.label}`,
      "",
      profile.notes,
      "",
      `Tested revision: ${profile.testedRevision ?? "Not tested"}.`,
      ""
    ]),
    "## Evidence",
    "",
    ...matrix.evidence.flatMap((evidence) => [
      `<a id="evidence-${evidence.id}"></a>`,
      `### ${evidence.label}`,
      "",
      `- Type: ${evidence.type}`,
      `- Outcome: ${evidence.outcome}`,
      `- Date: ${evidence.date}`,
      `- Revision: ${evidence.revision}`,
      `- Run: ${evidence.url ?? "Not available"}`,
      `- Sources: ${evidence.sourcePaths.join(", ")}`,
      "",
      evidence.notes,
      ""
    ]),
    "## Known issues",
    "",
    ...(matrix.knownIssues.length > 0 ? matrix.knownIssues.flatMap((issue) => [
      `<a id="issue-${issue.id}"></a>`,
      `### ${issue.id}`,
      "",
      issue.summary,
      "",
      `Workaround: ${issue.workaround}`,
      "",
      `Sources: ${issue.sourcePaths.join(", ")}.`,
      ""
    ]) : ["No known issues are recorded for confirmed profiles.", ""]),
    "## Updating the matrix",
    "",
    "- Record exact device, OS, browser, date, and revision for qualifying tests.",
    "- Do not treat Chromium mobile emulation or synthetic WebXR as physical-device evidence.",
    "- Update `lastReviewed` when the release owner records `updated` or `reviewed unchanged`.",
    "- Regenerate this file and run `pnpm validate:compatibility` before opening a pull request.",
    ""
  ];
  return `${lines.join("\n").replace(/\n{3,}/g, "\n\n").trim()}\n`;
}

export async function loadCompatibilityMatrix(rootDir = process.cwd(), matrixPath = DEFAULT_MATRIX_PATH) {
  return JSON.parse(await readFile(join(rootDir, matrixPath), "utf8"));
}

async function main() {
  const rootDir = process.cwd();
  const writeDocs = process.argv.slice(2).includes("--write-docs");
  const matrix = await loadCompatibilityMatrix(rootDir);
  const errors = validateCompatibilityMatrix(matrix, { rootDir });
  if (errors.length > 0) {
    for (const error of errors) console.error(`${error.code}:${error.path}:${error.message}`);
    process.exitCode = 1;
    return;
  }

  const expectedDocs = renderCompatibilityMarkdown(matrix);
  const docsPath = join(rootDir, DEFAULT_DOCS_PATH);
  if (writeDocs) {
    await writeFile(docsPath, expectedDocs, "utf8");
    console.log(`compatibility_docs_written:${DEFAULT_DOCS_PATH}`);
    return;
  }

  const actualDocs = await readFile(docsPath, "utf8").catch(() => null);
  if (actualDocs !== expectedDocs) {
    console.error("compatibility_docs_out_of_date:run pnpm validate:compatibility -- --write-docs");
    process.exitCode = 1;
    return;
  }
  console.log("compatibility_matrix_ok");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
