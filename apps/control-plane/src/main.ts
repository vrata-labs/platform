import {
  createControlPlanePageState,
  createRoom,
  fetchRoomDiagnostics,
  fetchRoomManifest,
  fetchTemplates,
  listAssets,
  listRooms,
  updateRoom,
  uploadAsset
} from "./index.js";

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
const featureVoiceInput = mustElement<HTMLInputElement>("#feature-voice-input");
const featureSpatialInput = mustElement<HTMLInputElement>("#feature-spatial-input");
const featureShareInput = mustElement<HTMLInputElement>("#feature-share-input");
const updateRoomButton = mustElement<HTMLButtonElement>("#update-room");
const publishStatus = mustElement<HTMLDivElement>("#publish-status");
const roomLink = mustElement<HTMLAnchorElement>("#room-link");
const refreshRoomDetailButton = mustElement<HTMLButtonElement>("#refresh-room-detail");
const roomsList = mustElement<HTMLUListElement>("#rooms-list");
const roomDetail = mustElement<HTMLPreElement>("#room-detail");
const assetsList = mustElement<HTMLUListElement>("#assets-list");
let selectedRoomPoll: number | undefined;

adminTokenInput.value = storedAdminToken;

function render(): void {
  publishStatus.textContent = state.statusMessage ?? state.publishStatus;
  roomLink.href = state.roomLink ?? "#";
  roomLink.textContent = state.roomLink ?? "";
  roomsList.replaceChildren(
    ...state.rooms.map((room) => {
      const item = document.createElement("li");
      const inspect = document.createElement("button");
      inspect.type = "button";
      inspect.textContent = `${room.name} (${room.templateId})${room.assetIds?.length ? ` assets:${room.assetIds.length}` : ""}${room.theme ? ` theme:${room.theme.primaryColor}` : ""}`;
      inspect.addEventListener("click", () => {
        void selectRoom(room);
      });
      const openLink = document.createElement("a");
      openLink.href = room.roomLink;
      openLink.textContent = "open";
      openLink.target = "_blank";
      openLink.rel = "noreferrer";
      item.appendChild(inspect);
      item.appendChild(document.createTextNode(" "));
      item.appendChild(openLink);
      return item;
    })
  );
  roomDetail.textContent = state.selectedRoom
    ? JSON.stringify({
        room: state.selectedRoom,
        manifest: state.selectedRoomManifest,
        diagnostics: state.selectedRoomDiagnostics.slice(-5)
      }, null, 2)
    : "Select a room to inspect details";
  assetsList.replaceChildren(
    ...state.assets.map((asset) => {
      const item = document.createElement("li");
      item.textContent = `${asset.kind}: ${asset.url}`;
      return item;
    })
  );
}

async function selectRoom(room: typeof state.selectedRoom): Promise<void> {
  if (!room) {
    return;
  }
  state.selectedRoom = room;
  state.selectedRoomManifest = await fetchRoomManifest(apiBaseUrl, room.roomId);
  state.selectedRoomDiagnostics = await fetchRoomDiagnostics(apiBaseUrl, room.roomId);
  roomNameInput.value = room.name;
  templateSelect.value = room.templateId;
  primaryColorInput.value = room.theme?.primaryColor ?? "#5fc8ff";
  accentColorInput.value = room.theme?.accentColor ?? "#163354";
  featureVoiceInput.checked = room.features?.voice ?? true;
  featureSpatialInput.checked = room.features?.spatialAudio ?? true;
  featureShareInput.checked = room.features?.screenShare ?? true;
  const assetIds = new Set(room.assetIds ?? []);
  Array.from(assetSelect.options).forEach((option) => {
    option.selected = assetIds.has(option.value);
  });
  render();
}

function startSelectedRoomPolling(): void {
  if (selectedRoomPoll) {
    window.clearInterval(selectedRoomPoll);
  }
  selectedRoomPoll = window.setInterval(() => {
    if (!state.selectedRoom) {
      return;
    }
    void selectRoom(state.selectedRoom);
  }, 5000);
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
  startSelectedRoomPolling();
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  state.publishStatus = "publishing";
  state.statusMessage = "publishing";
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
    features: {
      voice: featureVoiceInput.checked,
      spatialAudio: featureSpatialInput.checked,
      screenShare: featureShareInput.checked
    }
  }, currentAuth())
    .then((room) => {
      state.publishStatus = "published";
      state.statusMessage = "published";
      state.roomLink = room.roomLink;
      state.rooms = [room, ...state.rooms];
      void selectRoom(room);
    })
    .catch(() => {
      state.publishStatus = "failed";
      state.statusMessage = "failed";
      render();
    });
});

assetForm.addEventListener("submit", (event) => {
  event.preventDefault();
  state.publishStatus = "publishing";
  state.statusMessage = "publishing";
  render();
  void uploadAsset(apiBaseUrl, {
    tenantId: "demo-tenant",
    kind: assetKindInput.value,
    url: assetUrlInput.value
  }, currentAuth())
    .then(async () => {
      state.publishStatus = "published";
      state.statusMessage = "published";
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
    .catch((error: unknown) => {
      state.publishStatus = "failed";
      state.statusMessage = error instanceof Error ? `failed:${error.message}` : "failed";
      render();
    });
});

refreshRoomDetailButton.addEventListener("click", () => {
  if (!state.selectedRoom) {
    return;
  }
  void selectRoom(state.selectedRoom);
});

updateRoomButton.addEventListener("click", () => {
  if (!state.selectedRoom) {
    return;
  }
  state.publishStatus = "publishing";
  state.statusMessage = "publishing";
  render();
  void updateRoom(apiBaseUrl, state.selectedRoom.roomId, {
    name: roomNameInput.value,
    templateId: templateSelect.value,
    assetIds: Array.from(assetSelect.selectedOptions).map((option) => option.value),
    theme: {
      primaryColor: primaryColorInput.value,
      accentColor: accentColorInput.value
    },
    features: {
      voice: featureVoiceInput.checked,
      spatialAudio: featureSpatialInput.checked,
      screenShare: featureShareInput.checked
    }
  }, currentAuth())
    .then(async (room) => {
      state.publishStatus = "published";
      state.statusMessage = "updated";
      state.roomLink = room.roomLink;
      state.rooms = state.rooms.map((item) => item.roomId === room.roomId ? room : item);
      await selectRoom(room);
    })
    .catch(() => {
      state.publishStatus = "failed";
      state.statusMessage = "failed";
      render();
    });
});

void bootstrap();
