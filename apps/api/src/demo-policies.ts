import type { ManagedRoomFeatures } from "./storage-contracts.js";

// Demo policies come from the portal (VRATA_DEMO_POLICIES, the contract demo-policy schema). The platform takes
// only what it enforces itself: templates, lifetime, idle timeout, participant limit and features. Quotas,
// rate limits, the kill switch and the media budget are the portal's.
export interface DemoPolicy {
  policyId: string;
  templates: readonly string[];
  absoluteLifetimeSeconds: number;
  idleTimeoutSeconds: number;
  maxParticipants: number;
  features: ManagedRoomFeatures;
}

const POLICY_ID_PATTERN = /^[a-z0-9-]{3,48}$/;
const DEMO_TEMPLATES = ["meeting-room-basic", "presentation-room-basic"];

function integerIn(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
}

function parsePolicy(entry: unknown, index: number): DemoPolicy {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error(`invalid_demo_policies:entry:${index}`);
  const policy = entry as Record<string, unknown>;
  const policyId = policy.policyId;
  if (typeof policyId !== "string" || !POLICY_ID_PATTERN.test(policyId)) throw new Error(`invalid_demo_policies:policy_id:${index}`);
  const templates = policy.templates;
  if (!Array.isArray(templates) || templates.length === 0 || new Set(templates).size !== templates.length
    || !templates.every(template => typeof template === "string" && DEMO_TEMPLATES.includes(template))) {
    throw new Error(`invalid_demo_policies:templates:${policyId}`);
  }
  if (!integerIn(policy.absoluteLifetimeSeconds, 300, 3600)) throw new Error(`invalid_demo_policies:absolute_lifetime:${policyId}`);
  if (!integerIn(policy.idleTimeoutSeconds, 60, 1800)) throw new Error(`invalid_demo_policies:idle_timeout:${policyId}`);
  if (!integerIn(policy.maxParticipants, 2, 8)) throw new Error(`invalid_demo_policies:max_participants:${policyId}`);
  const features = policy.features as Record<string, unknown> | undefined;
  if (!features || typeof features !== "object" || typeof features.voice !== "boolean" || typeof features.screenShare !== "boolean"
    || typeof features.documents !== "boolean" || features.upload !== false || features.remoteBrowser !== false) {
    throw new Error(`invalid_demo_policies:features:${policyId}`);
  }
  return {
    policyId,
    templates: templates as string[],
    absoluteLifetimeSeconds: policy.absoluteLifetimeSeconds,
    idleTimeoutSeconds: policy.idleTimeoutSeconds,
    maxParticipants: policy.maxParticipants,
    features: { voice: features.voice, screenShare: features.screenShare, documents: features.documents }
  };
}

// VRATA_DEMO_POLICIES is a JSON array of demo policies; unset means this deployment creates no demo instances.
export function parseDemoPolicies(raw: string | undefined): ReadonlyMap<string, DemoPolicy> {
  const policies = new Map<string, DemoPolicy>();
  if (raw === undefined || raw.trim() === "") return policies;
  let entries: unknown;
  try {
    entries = JSON.parse(raw);
  } catch {
    throw new Error("invalid_demo_policies:json");
  }
  if (!Array.isArray(entries)) throw new Error("invalid_demo_policies:not_array");
  entries.forEach((entry, index) => {
    const policy = parsePolicy(entry, index);
    if (policies.has(policy.policyId)) throw new Error(`invalid_demo_policies:duplicate:${policy.policyId}`);
    policies.set(policy.policyId, policy);
  });
  return policies;
}

let cached: { raw: string | undefined; policies: ReadonlyMap<string, DemoPolicy> } | null = null;

export function loadDemoPolicies(env: NodeJS.ProcessEnv = process.env): ReadonlyMap<string, DemoPolicy> {
  const raw = env.VRATA_DEMO_POLICIES;
  if (!cached || cached.raw !== raw) cached = { raw, policies: parseDemoPolicies(raw) };
  return cached.policies;
}
