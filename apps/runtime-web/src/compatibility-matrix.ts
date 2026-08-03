import matrixData from "./compatibility-matrix.json" with { type: "json" };

export type CompatibilityStatus = "supported" | "degraded" | "unsupported" | "untested";
export type CompatibilityEvidenceType = "automated" | "emulation" | "manual-device" | "product-decision";
export type CompatibilityEvidenceOutcome = "passed" | "failed" | "decision" | "informational";

export interface CompatibilityCapability {
  id: string;
  label: string;
  passCriteria: string;
}

export interface CompatibilityCell {
  status: CompatibilityStatus;
  evidenceIds: string[];
  knownIssueIds: string[];
}

export interface CompatibilityProfile {
  id: string;
  category: "desktop" | "mobile" | "vr";
  label: string;
  device: string;
  deviceVersion: string | null;
  os: string;
  osVersion: string | null;
  browser: string;
  browserVersion: string | null;
  lastReviewed: string;
  lastTested: string | null;
  testedRevision: string | null;
  notes: string;
  capabilities: Record<string, CompatibilityCell>;
}

export interface CompatibilityEvidence {
  id: string;
  type: CompatibilityEvidenceType;
  outcome: CompatibilityEvidenceOutcome;
  label: string;
  date: string;
  revision: string;
  profileIds: string[];
  capabilityIds: string[];
  url?: string | null;
  sourcePaths: string[];
  notes: string;
}

export interface CompatibilityKnownIssue {
  id: string;
  summary: string;
  profileIds: string[];
  capabilityIds: string[];
  workaround: string;
  sourcePaths: string[];
}

export interface CompatibilityMatrix {
  schemaVersion: 1;
  title: string;
  reviewOwner: string;
  assumptions: string[];
  statusDefinitions: Record<CompatibilityStatus, string>;
  capabilities: CompatibilityCapability[];
  profiles: CompatibilityProfile[];
  evidence: CompatibilityEvidence[];
  knownIssues: CompatibilityKnownIssue[];
}

export const compatibilityMatrix = matrixData as CompatibilityMatrix;
