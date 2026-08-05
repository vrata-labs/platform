import type { RoomTemplateStatus } from "@vrata/shared-types";

export interface TemplateDefinition {
  id: string;
  label: string;
  assetSlots: string[];
}

export interface VersionedTemplateDefinition extends TemplateDefinition {
  version: string;
  status: RoomTemplateStatus;
}

export type ImmutableVersionedTemplateDefinition = Readonly<{
  id: string;
  label: string;
  assetSlots: readonly string[];
  version: string;
  status: RoomTemplateStatus;
}>;

function freezeDefinition(definition: VersionedTemplateDefinition): ImmutableVersionedTemplateDefinition {
  return Object.freeze({
    ...definition,
    assetSlots: Object.freeze([...definition.assetSlots])
  });
}

export const versionedTemplateDefinitions: readonly ImmutableVersionedTemplateDefinition[] = Object.freeze([
  freezeDefinition({
    id: "meeting-room-basic",
    label: "Meeting Room Basic",
    assetSlots: ["logo", "hero-screen"],
    version: "0.1.0",
    status: "active"
  }),
  freezeDefinition({
    id: "showroom-basic",
    label: "Showroom Basic",
    assetSlots: ["logo", "wall-graphic"],
    version: "0.1.0",
    status: "active"
  }),
  freezeDefinition({
    id: "event-demo-basic",
    label: "Event Demo Basic",
    assetSlots: ["logo", "media-placeholder"],
    version: "0.1.0",
    status: "active"
  }),
  freezeDefinition({
    id: "personal-workspace-basic",
    label: "Personal Workspace Basic",
    assetSlots: ["logo", "personal-surface"],
    version: "0.1.0",
    status: "active"
  })
]);

export function createLegacyTemplateDefinitions(): TemplateDefinition[] {
  return versionedTemplateDefinitions.map((definition) => ({
    id: definition.id,
    label: definition.label,
    assetSlots: [...definition.assetSlots]
  }));
}

export function cloneVersionedTemplateDefinition(definition: ImmutableVersionedTemplateDefinition): VersionedTemplateDefinition {
  return {
    id: definition.id,
    label: definition.label,
    assetSlots: [...definition.assetSlots],
    version: definition.version,
    status: definition.status
  };
}
