import type { RoomTemplateVersionSnapshotV1 } from "@vrata/shared-types";
import { templates } from "./index.js";
import {
  cloneVersionedTemplateDefinition,
  versionedTemplateDefinitions,
  type ImmutableVersionedTemplateDefinition,
  type TemplateDefinition,
  type VersionedTemplateDefinition
} from "./definitions.js";

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

export function listTemplateDefinitions(): VersionedTemplateDefinition[] {
  return versionedTemplateDefinitions.map(cloneVersionedTemplateDefinition);
}

export function getCurrentTemplateVersion(templateId: string): RoomTemplateVersionSnapshotV1 | undefined {
  const template = versionedTemplateDefinitions.find((candidate) => candidate.id === templateId);
  return template ? createVersionSnapshot(template) : undefined;
}

export function getTemplateVersion(templateId: string, version: string): RoomTemplateVersionSnapshotV1 | undefined {
  const template = versionedTemplateDefinitions.find((candidate) => candidate.id === templateId && candidate.version === version);
  return template ? createVersionSnapshot(template) : undefined;
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

function createVersionSnapshot(template: ImmutableVersionedTemplateDefinition): RoomTemplateVersionSnapshotV1 {
  return {
    schemaVersion: 1,
    templateId: template.id,
    version: template.version,
    label: template.label,
    assetSlots: [...template.assetSlots]
  };
}
