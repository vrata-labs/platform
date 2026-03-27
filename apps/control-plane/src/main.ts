import { createControlPlanePageState, createRoom, fetchTemplates, listAssets, listRooms, uploadAsset } from "./index.js";

function mustElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) {
    throw new Error(`control_plane_dom_missing:${selector}`);
  }
  return element;
}

const apiBaseUrl = window.location.origin;
const state = createControlPlanePageState();
const storedAdminToken = localStorage.getItem("noah.controlPlaneAdminToken") ?? "";

const form = mustElement<HTMLFormElement>("#room-form");
const assetForm = mustElement<HTMLFormElement>("#asset-form");
const adminTokenInput = mustElement<HTMLInputElement>("#admin-token-input");
const roomNameInput = mustElement<HTMLInputElement>("#room-name-input");
const assetKindInput = mustElement<HTMLInputElement>("#asset-kind-input");
const assetUrlInput = mustElement<HTMLInputElement>("#asset-url-input");
const templateSelect = mustElement<HTMLSelectElement>("#template-select");
const assetSelect = mustElement<HTMLSelectElement>("#asset-select");
const primaryColorInput = mustElement<HTMLInputElement>("#primary-color-input");
const accentColorInput = mustElement<HTMLInputElement>("#accent-color-input");
const publishStatus = mustElement<HTMLDivElement>("#publish-status");
const roomLink = mustElement<HTMLAnchorElement>("#room-link");
const roomsList = mustElement<HTMLUListElement>("#rooms-list");
const assetsList = mustElement<HTMLUListElement>("#assets-list");

adminTokenInput.value = storedAdminToken;

function render(): void {
  publishStatus.textContent = state.publishStatus;
  roomLink.href = state.roomLink ?? "#";
  roomLink.textContent = state.roomLink ?? "";
  roomsList.replaceChildren(
    ...state.rooms.map((room) => {
      const item = document.createElement("li");
      const link = document.createElement("a");
      link.href = room.roomLink;
      link.textContent = `${room.name} (${room.templateId})${room.assetIds?.length ? ` assets:${room.assetIds.length}` : ""}${room.theme ? ` theme:${room.theme.primaryColor}` : ""}`;
      link.target = "_blank";
      link.rel = "noreferrer";
      item.appendChild(link);
      return item;
    })
  );
  assetsList.replaceChildren(
    ...state.assets.map((asset) => {
      const item = document.createElement("li");
      item.textContent = `${asset.kind}: ${asset.url}`;
      return item;
    })
  );
}

function currentAuth(): { adminToken?: string } {
  const token = adminTokenInput.value.trim();
  localStorage.setItem("noah.controlPlaneAdminToken", token);
  return token ? { adminToken: token } : {};
}

async function bootstrap(): Promise<void> {
  state.templates = await fetchTemplates(apiBaseUrl);
  state.rooms = await listRooms(apiBaseUrl);
  state.assets = await listAssets(apiBaseUrl);
  templateSelect.replaceChildren(
    ...state.templates.map((template) => {
      const option = document.createElement("option");
      option.value = template.templateId;
      option.textContent = template.label;
      return option;
    })
  );
  assetSelect.replaceChildren(
    ...state.assets.map((asset) => {
      const option = document.createElement("option");
      option.value = asset.assetId;
      option.textContent = `${asset.kind}: ${asset.url}`;
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
    assetIds: Array.from(assetSelect.selectedOptions).map((option) => option.value),
    theme: {
      primaryColor: primaryColorInput.value,
      accentColor: accentColorInput.value
    },
    features: { voice: true, spatialAudio: true, screenShare: true }
  }, currentAuth())
    .then((room) => {
      state.publishStatus = "published";
      state.roomLink = room.roomLink;
      state.rooms = [room, ...state.rooms];
      render();
    })
    .catch(() => {
      state.publishStatus = "failed";
      render();
    });
});

assetForm.addEventListener("submit", (event) => {
  event.preventDefault();
  state.publishStatus = "publishing";
  render();
  void uploadAsset(apiBaseUrl, {
    tenantId: "demo-tenant",
    kind: assetKindInput.value,
    url: assetUrlInput.value
  }, currentAuth())
    .then(async () => {
      state.publishStatus = "published";
      state.assets = await listAssets(apiBaseUrl);
      assetSelect.replaceChildren(
        ...state.assets.map((asset) => {
          const option = document.createElement("option");
          option.value = asset.assetId;
          option.textContent = `${asset.kind}: ${asset.url}`;
          return option;
        })
      );
      render();
    })
    .catch(() => {
      state.publishStatus = "failed";
      render();
    });
});

void bootstrap();
