import {
  compatibilityMatrix,
  type CompatibilityCell,
  type CompatibilityEvidence,
  type CompatibilityKnownIssue,
  type CompatibilityProfile,
  type CompatibilityStatus
} from "./compatibility-matrix.js";

const statusOrder: CompatibilityStatus[] = ["supported", "degraded", "unsupported", "untested"];

function mustElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`compatibility_dom_missing:${selector}`);
  return element;
}

function createElement<K extends keyof HTMLElementTagNameMap>(
  tagName: K,
  options: { className?: string; text?: string } = {}
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tagName);
  if (options.className) element.className = options.className;
  if (options.text !== undefined) element.textContent = options.text;
  return element;
}

function appendDefinition(list: HTMLDListElement, term: string, description: string): void {
  list.append(
    createElement("dt", { text: term }),
    createElement("dd", { text: description })
  );
}

function environmentLines(profile: CompatibilityProfile): string[] {
  return [
    `${profile.device}${profile.deviceVersion ? ` · ${profile.deviceVersion}` : ""}`,
    `${profile.os}${profile.osVersion ? ` · ${profile.osVersion}` : ""}`,
    `${profile.browser}${profile.browserVersion ? ` · ${profile.browserVersion}` : ""}`
  ];
}

function createRecordLink(kind: "Evidence" | "Issue", id: string, context: string): HTMLAnchorElement {
  const prefix = kind === "Evidence" ? "evidence" : "issue";
  const link = createElement("a", { className: "compatibility-record-link", text: kind });
  link.href = `#${prefix}-${id}`;
  link.setAttribute("aria-label", `${kind} for ${context}: ${id}`);
  return link;
}

function renderStatusCell(cell: CompatibilityCell, profile: CompatibilityProfile, capabilityLabel: string): HTMLTableCellElement {
  const tableCell = createElement("td", { className: "compatibility-status-cell" });
  const badge = createElement("span", {
    className: `compatibility-status compatibility-status-${cell.status}`,
    text: cell.status
  });
  tableCell.dataset.status = cell.status;
  tableCell.append(badge);

  if (cell.evidenceIds.length > 0 || cell.knownIssueIds.length > 0) {
    const links = createElement("div", { className: "compatibility-cell-links" });
    const context = `${capabilityLabel} on ${profile.label}`;
    for (const evidenceId of cell.evidenceIds) links.append(createRecordLink("Evidence", evidenceId, context));
    for (const issueId of cell.knownIssueIds) links.append(createRecordLink("Issue", issueId, context));
    tableCell.append(links);
  }
  return tableCell;
}

function renderLegend(): void {
  const legend = mustElement<HTMLElement>("#compatibility-legend");
  for (const status of statusOrder) {
    const item = createElement("article", { className: "compatibility-legend-item" });
    item.dataset.status = status;
    item.append(
      createElement("span", {
        className: `compatibility-status compatibility-status-${status}`,
        text: status
      }),
      createElement("p", { text: compatibilityMatrix.statusDefinitions[status] })
    );
    legend.append(item);
  }
}

function renderMatrix(): void {
  const head = mustElement<HTMLTableSectionElement>("#compatibility-matrix-head");
  const body = mustElement<HTMLTableSectionElement>("#compatibility-matrix-body");
  const headerRow = createElement("tr");
  for (const label of [
    "Client profile",
    "Exact environment",
    ...compatibilityMatrix.capabilities.map((capability) => capability.label),
    "Last reviewed",
    "Last tested"
  ]) {
    const header = createElement("th", { text: label });
    header.scope = "col";
    headerRow.append(header);
  }
  head.append(headerRow);

  for (const profile of compatibilityMatrix.profiles) {
    const row = createElement("tr");
    row.dataset.profileId = profile.id;
    const profileHeader = createElement("th");
    profileHeader.scope = "row";
    const profileLink = createElement("a", { text: profile.label });
    profileLink.href = `#profile-${profile.id}`;
    profileHeader.append(profileLink);
    row.append(profileHeader);

    const environment = createElement("td", { className: "compatibility-environment" });
    for (const line of environmentLines(profile)) environment.append(createElement("span", { text: line }));
    row.append(environment);

    for (const capability of compatibilityMatrix.capabilities) {
      row.append(renderStatusCell(profile.capabilities[capability.id], profile, capability.label));
    }
    row.append(
      createElement("td", { className: "compatibility-date", text: profile.lastReviewed }),
      createElement("td", { className: "compatibility-date", text: profile.lastTested ?? "Not tested" })
    );
    body.append(row);
  }
}

function renderCriteria(): void {
  const container = mustElement<HTMLElement>("#compatibility-criteria");
  for (const capability of compatibilityMatrix.capabilities) {
    const item = createElement("article", { className: "compatibility-card" });
    item.append(
      createElement("div", { className: "compatibility-card-index", text: capability.id }),
      createElement("h3", { text: capability.label }),
      createElement("p", { text: capability.passCriteria })
    );
    container.append(item);
  }
}

function renderProfiles(): void {
  const assumptions = mustElement<HTMLUListElement>("#compatibility-assumptions");
  const profiles = mustElement<HTMLElement>("#compatibility-profiles");
  for (const assumption of compatibilityMatrix.assumptions) assumptions.append(createElement("li", { text: assumption }));

  for (const profile of compatibilityMatrix.profiles) {
    const item = createElement("article", { className: "compatibility-card compatibility-profile" });
    item.id = `profile-${profile.id}`;
    item.dataset.profileId = profile.id;
    const heading = createElement("h3", { text: profile.label });
    const metadata = createElement("dl", { className: "compatibility-metadata" });
    appendDefinition(metadata, "Category", profile.category);
    appendDefinition(metadata, "Environment", environmentLines(profile).join(" / "));
    appendDefinition(metadata, "Last reviewed", profile.lastReviewed);
    appendDefinition(metadata, "Last tested", profile.lastTested ?? "Not tested");
    appendDefinition(metadata, "Tested revision", profile.testedRevision ?? "Not tested");
    item.append(heading, metadata, createElement("p", { text: profile.notes }));
    profiles.append(item);
  }
}

function renderEvidenceItem(evidence: CompatibilityEvidence): HTMLElement {
  const item = createElement("article", { className: "compatibility-record" });
  item.id = `evidence-${evidence.id}`;
  item.dataset.evidenceId = evidence.id;
  const heading = createElement("h3", { text: evidence.label });
  const metadata = createElement("dl", { className: "compatibility-metadata" });
  appendDefinition(metadata, "Type", evidence.type);
  appendDefinition(metadata, "Outcome", evidence.outcome);
  appendDefinition(metadata, "Date", evidence.date);
  appendDefinition(metadata, "Revision", evidence.revision);
  appendDefinition(metadata, "Profiles", evidence.profileIds.join(", "));
  appendDefinition(metadata, "Capabilities", evidence.capabilityIds.join(", "));
  appendDefinition(metadata, "Sources", evidence.sourcePaths.join(", "));
  item.append(heading, metadata, createElement("p", { text: evidence.notes }));
  if (evidence.url) {
    const link = createElement("a", { className: "compatibility-external-link", text: "Open test run" });
    link.href = evidence.url;
    link.target = "_blank";
    link.rel = "noreferrer";
    item.append(link);
  }
  return item;
}

function renderIssueItem(issue: CompatibilityKnownIssue): HTMLElement {
  const item = createElement("article", { className: "compatibility-record compatibility-record-issue" });
  item.id = `issue-${issue.id}`;
  item.dataset.issueId = issue.id;
  const metadata = createElement("dl", { className: "compatibility-metadata" });
  appendDefinition(metadata, "Profiles", issue.profileIds.join(", "));
  appendDefinition(metadata, "Capabilities", issue.capabilityIds.join(", "));
  appendDefinition(metadata, "Sources", issue.sourcePaths.join(", "));
  item.append(
    createElement("h3", { text: issue.id }),
    createElement("p", { text: issue.summary }),
    metadata,
    createElement("p", { className: "compatibility-workaround", text: `Workaround: ${issue.workaround}` })
  );
  return item;
}

function renderRecords(): void {
  const evidenceContainer = mustElement<HTMLElement>("#compatibility-evidence");
  const issuesContainer = mustElement<HTMLElement>("#compatibility-known-issues");
  for (const evidence of compatibilityMatrix.evidence) evidenceContainer.append(renderEvidenceItem(evidence));
  if (compatibilityMatrix.knownIssues.length === 0) {
    issuesContainer.append(createElement("p", { text: "No known issues are recorded for confirmed profiles." }));
  } else {
    for (const issue of compatibilityMatrix.knownIssues) issuesContainer.append(renderIssueItem(issue));
  }
}

function renderReviewSummary(): void {
  const latestReview = compatibilityMatrix.profiles.map((profile) => profile.lastReviewed).sort().at(-1) ?? "Unknown";
  mustElement<HTMLElement>("#compatibility-review-summary").textContent = `Review owner: ${compatibilityMatrix.reviewOwner}. Latest review: ${latestReview}.`;
}

renderReviewSummary();
renderLegend();
renderMatrix();
renderCriteria();
renderProfiles();
renderRecords();

(window as Window & { __VRATA_COMPATIBILITY__?: typeof compatibilityMatrix }).__VRATA_COMPATIBILITY__ = compatibilityMatrix;
