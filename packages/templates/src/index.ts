import { createLegacyTemplateDefinitions, type TemplateDefinition } from "./definitions.js";

export type { TemplateDefinition, VersionedTemplateDefinition } from "./definitions.js";

export const templates: TemplateDefinition[] = createLegacyTemplateDefinitions();

export * from "./asset-lock.js";
export * from "./registry.js";
export * from "./standard-room-contracts.js";
export * from "./standard-room-definitions.js";
export * from "./version-contract.js";
export * from "./materialization.js";
export * from "./product-room-definitions.js";
export * from "./catalog-transition.js";
