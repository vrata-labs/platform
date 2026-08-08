import { createLegacyTemplateDefinitions, type TemplateDefinition } from "./definitions.js";

export type { TemplateDefinition, VersionedTemplateDefinition } from "./definitions.js";

export const templates: TemplateDefinition[] = createLegacyTemplateDefinitions();

export * from "./asset-lock.js";
export * from "./registry.js";
export * from "./standard-room-contracts.js";
export * from "./version-contract.js";
