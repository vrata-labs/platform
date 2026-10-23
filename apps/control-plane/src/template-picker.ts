import type { RoomCreateInput, RoomRecord, TemplateRecord } from "./index.js";

export const personalOwnerHandoffHint = "Owner is assigned only after a v2 member invite and an explicit owner transfer.";

export function displayOwnerParticipantId(room: Pick<RoomRecord, "ownerParticipantId" | "currentOwnerParticipantId">): string | null {
  return room.currentOwnerParticipantId !== undefined ? room.currentOwnerParticipantId : room.ownerParticipantId ?? null;
}

export function personalRoomInviteFields(room: Pick<RoomRecord, "roomType" | "ownerParticipantId" | "currentOwnerParticipantId">): { role?: "member" } {
  return room.roomType === "personal" && displayOwnerParticipantId(room) == null ? { role: "member" } : {};
}

export function templateCreationFields(template: TemplateRecord | undefined, ownerId: string, identityFloor: 1 | 2 = 1): Partial<RoomCreateInput> {
  if (!template?.defaults) return {};
  return {
    templateVersion: template.currentVersion,
    roomType: template.defaults.roomType,
    ...(template.defaults.roomType === "personal" ? { ownerParticipantId: identityFloor === 2 ? null : ownerId.trim() } : {})
  };
}

export function templateDefaultsSummary(template: TemplateRecord): string {
  const defaults = template.defaults;
  if (!defaults) return `${template.label}${template.currentVersion ? ` v${template.currentVersion}` : ""}`;
  return `${template.label} v${template.currentVersion} · ${defaults.visibility} · ${defaults.settings.notes.defaultScope} notes · ${defaults.settings.audio.joinMutedByDefault ? "join muted" : "audio on request"}`;
}

export function renderTemplateCards(container: HTMLElement, templates: TemplateRecord[], select: (id: string) => void): void {
  container.replaceChildren(...templates.filter(template => template.defaults).map(template => {
    const card = document.createElement("label"); card.className = "template-card";
    const input = document.createElement("input"); input.type = "radio"; input.name = "template-choice"; input.value = template.templateId;
    input.addEventListener("change", () => { if (input.checked) select(template.templateId); });
    const title = document.createElement("strong"); title.textContent = `${template.label} v${template.currentVersion}`;
    const description = document.createElement("small"); description.textContent = template.description ?? "";
    card.append(input);
    if (template.previewUrl) {
      const image = document.createElement("img"); image.src = template.previewUrl;
      image.alt = `${template.label} scene preview`; image.loading = "lazy";
      image.addEventListener("error", () => { image.hidden = true; description.textContent = `${template.description ?? ""} Preview unavailable; this layout can still be selected.`; });
      card.append(image);
    }
    card.append(title, description);
    return card;
  }));
}
