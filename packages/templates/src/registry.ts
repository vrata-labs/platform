import { templates, type TemplateDefinition } from "./index.js";

export interface SpaceManifest {
  schemaVersion: number;
  templateId: string;
  assetSlots: string[];
  themeTokens: {
    primaryColor: string;
    accentColor: string;
  };
}

export function getTemplateDefinition(templateId: string): TemplateDefinition | undefined {
  return templates.find((template) => template.id === templateId);
}

export function createSpaceManifest(templateId: string): SpaceManifest {
  const template = getTemplateDefinition(templateId);

  if (!template) {
    throw new Error(`unknown_template:${templateId}`);
  }

  return {
    schemaVersion: 1,
    templateId,
    assetSlots: template.assetSlots,
    themeTokens: {
      primaryColor: "#2157ff",
      accentColor: "#0d1222"
    }
  };
}
