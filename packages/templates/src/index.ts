export interface TemplateDefinition {
  id: string;
  label: string;
  assetSlots: string[];
}

export const templates: TemplateDefinition[] = [
  {
    id: "meeting-room-basic",
    label: "Meeting Room Basic",
    assetSlots: ["logo", "hero-screen"]
  },
  {
    id: "showroom-basic",
    label: "Showroom Basic",
    assetSlots: ["logo", "wall-graphic"]
  },
  {
    id: "event-demo-basic",
    label: "Event Demo Basic",
    assetSlots: ["logo", "media-placeholder"]
  }
];

export * from "./registry.js";
