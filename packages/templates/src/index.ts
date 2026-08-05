import { createLegacyTemplateDefinitions, type TemplateDefinition } from "./definitions.js";

export type { TemplateDefinition, VersionedTemplateDefinition } from "./definitions.js";

export const templates: TemplateDefinition[] = createLegacyTemplateDefinitions();

export * from "./registry.js";
