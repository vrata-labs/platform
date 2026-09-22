import type { RoomTemplateCatalogRecord } from "@vrata/shared-types";
import { PRODUCT_ROOM_TEMPLATE_VERSION } from "./product-room-definitions.js";

export type ReferenceCatalogState = "wave2" | "active";
export type TemplateCatalogPointer = Pick<RoomTemplateCatalogRecord, "templateId" | "currentVersion" | "status">;
const aliases = ["personal-workspace-basic", "showroom-basic", "event-demo-basic"];

export function expectedReferenceCatalog(state: ReferenceCatalogState): TemplateCatalogPointer[] {
  return [
    { templateId: "meeting-room-basic", currentVersion: state === "active" ? PRODUCT_ROOM_TEMPLATE_VERSION : "0.1.0", status: "active" },
    ...aliases.map(templateId => ({ templateId, currentVersion: "0.1.0", status: state === "active" ? "deprecated" as const : "active" as const })),
    ...["personal-room-basic", "presentation-room-basic"].map(templateId => ({ templateId, currentVersion: PRODUCT_ROOM_TEMPLATE_VERSION, status: state === "active" ? "active" as const : "deprecated" as const }))
  ];
}

export function referenceCatalogState(catalog: TemplateCatalogPointer[]): ReferenceCatalogState | null {
  if (new Set(catalog.map(value => value.templateId)).size !== catalog.length) return null;
  for (const state of ["wave2", "active"] as const) {
    const expected = expectedReferenceCatalog(state);
    if (expected.every(value => catalog.some(actual => actual.templateId === value.templateId && actual.currentVersion === value.currentVersion && actual.status === value.status))
      && catalog.every(value => value.status === "deprecated" || expected.some(item => item.templateId === value.templateId))) return state;
  }
  return null;
}

export function planReferenceCatalogTransition(catalog: TemplateCatalogPointer[], target: ReferenceCatalogState): TemplateCatalogPointer[] {
  if (target !== "wave2" && target !== "active") throw new Error("invalid_template_catalog_target");
  const current = referenceCatalogState(catalog);
  if (!current) throw new Error("template_catalog_state_mismatch");
  return current === target ? [] : expectedReferenceCatalog(target);
}
