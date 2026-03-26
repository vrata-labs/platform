import { createControlPlanePageState, createRoom, fetchTemplates } from "./index.js";

function mustElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) {
    throw new Error(`control_plane_dom_missing:${selector}`);
  }
  return element;
}

const apiBaseUrl = window.location.origin;
const state = createControlPlanePageState();

const form = mustElement<HTMLFormElement>("#room-form");
const roomNameInput = mustElement<HTMLInputElement>("#room-name-input");
const templateSelect = mustElement<HTMLSelectElement>("#template-select");
const publishStatus = mustElement<HTMLDivElement>("#publish-status");
const roomLink = mustElement<HTMLAnchorElement>("#room-link");

function render(): void {
  publishStatus.textContent = state.publishStatus;
  roomLink.href = state.roomLink ?? "#";
  roomLink.textContent = state.roomLink ?? "";
}

async function bootstrap(): Promise<void> {
  state.templates = await fetchTemplates(apiBaseUrl);
  templateSelect.replaceChildren(
    ...state.templates.map((template) => {
      const option = document.createElement("option");
      option.value = template.templateId;
      option.textContent = template.label;
      return option;
    })
  );
  render();
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  state.publishStatus = "publishing";
  render();
  void createRoom(apiBaseUrl, {
    tenantId: "demo-tenant",
    templateId: templateSelect.value,
    name: roomNameInput.value,
    features: { voice: true, spatialAudio: true, screenShare: true }
  })
    .then((room) => {
      state.publishStatus = "published";
      state.roomLink = room.roomLink;
      render();
    })
    .catch(() => {
      state.publishStatus = "failed";
      render();
    });
});

void bootstrap();
