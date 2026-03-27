import {
  createTenant,
  createControlPlanePageState,
  createRoom,
  deleteAsset,
  deleteTenant,
  deleteRoom,
  fetchRoomDiagnostics,
  fetchRoomManifest,
  fetchTemplates,
  listAssets,
  listRooms,
  listTenants,
  updateAsset,
  updateTenant,
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
const tenantForm = mustElement<HTMLFormElement>("#tenant-form");
const adminTokenInput = mustElement<HTMLInputElement>("#admin-token-input");
const tenantSelect = mustElement<HTMLSelectElement>("#tenant-select");
const tenantNameInput = mustElement<HTMLInputElement>("#tenant-name-input");
const updateTenantButton = mustElement<HTMLButtonElement>("#update-tenant");
const deleteTenantButton = mustElement<HTMLButtonElement>("#delete-tenant");
const roomNameInput = mustElement<HTMLInputElement>("#room-name-input");
const assetKindInput = mustElement<HTMLInputElement>("#asset-kind-input");
const assetUrlInput = mustElement<HTMLInputElement>("#asset-url-input");
const updateAssetButton = mustElement<HTMLButtonElement>("#update-asset");
const deleteAssetButton = mustElement<HTMLButtonElement>("#delete-asset");
const templateSelect = mustElement<HTMLSelectElement>("#template-select");
const assetSelect = mustElement<HTMLSelectElement>("#asset-select");
const primaryColorInput = mustElement<HTMLInputElement>("#primary-color-input");
const accentColorInput = mustElement<HTMLInputElement>("#accent-color-input");
const featureVoiceInput = mustElement<HTMLInputElement>("#feature-voice-input");
const featureSpatialInput = mustElement<HTMLInputElement>("#feature-spatial-input");
const featureShareInput = mustElement<HTMLInputElement>("#feature-share-input");
const guestAccessInput = mustElement<HTMLInputElement>("#guest-access-input");
const updateRoomButton = mustElement<HTMLButtonElement>("#update-room");
const deleteRoomButton = mustElement<HTMLButtonElement>("#delete-room");
const publishStatus = mustElement<HTMLDivElement>("#publish-status");
const roomLink = mustElement<HTMLAnchorElement>("#room-link");
const refreshRoomDetailButton = mustElement<HTMLButtonElement>("#refresh-room-detail");
const templateDetail = mustElement<HTMLPreElement>("#template-detail");
const roomFilterTenant = mustElement<HTMLSelectElement>("#room-filter-tenant");
const roomsList = mustElement<HTMLUListElement>("#rooms-list");
const roomDetail = mustElement<HTMLPreElement>("#room-detail");
const tenantsList = mustElement<HTMLUListElement>("#tenants-list");
const assetsList = mustElement<HTMLUListElement>("#assets-list");
let selectedRoomPoll: number | undefined;

adminTokenInput.value = storedAdminToken;

function render(): void {
  publishStatus.textContent = state.statusMessage ?? state.publishStatus;
  roomLink.href = state.roomLink ?? "#";
  roomLink.textContent = state.roomLink ?? "";
  templateDetail.textContent = state.selectedTemplate
    ? JSON.stringify(state.selectedTemplate, null, 2)
    : "Select a template to inspect details";
  const visibleRooms = state.roomFilterTenantId
    ? state.rooms.filter((room) => room.tenantId === state.roomFilterTenantId)
    : state.rooms;
  roomsList.replaceChildren(
    ...visibleRooms.map((room) => {
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
  tenantsList.replaceChildren(
    ...state.tenants.map((tenant) => {
      const item = document.createElement("li");
      const selectButton = document.createElement("button");
      selectButton.type = "button";
      selectButton.textContent = `${tenant.name} (${tenant.tenantId})`;
      selectButton.addEventListener("click", () => {
        state.selectedTenant = tenant;
        tenantSelect.value = tenant.tenantId;
        tenantNameInput.value = tenant.name;
        render();
      });
      item.appendChild(selectButton);
      return item;
    })
  );
  assetsList.replaceChildren(
    ...state.assets.map((asset) => {
      const item = document.createElement("li");
      const selectButton = document.createElement("button");
      selectButton.type = "button";
      selectButton.textContent = `${asset.kind}: ${asset.url}`;
      selectButton.addEventListener("click", () => {
        state.selectedAsset = asset;
        assetKindInput.value = asset.kind;
        assetUrlInput.value = asset.url;
        render();
      });
      item.appendChild(selectButton);
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
  guestAccessInput.checked = room.guestAllowed ?? state.selectedRoomManifest?.access.guestAllowed ?? true;
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

function renderTenantOptions(): void {
  tenantSelect.replaceChildren(
    ...state.tenants.map((tenant) => {
      const option = document.createElement("option");
      option.value = tenant.tenantId;
      option.textContent = tenant.name;
      return option;
    })
  );
  roomFilterTenant.replaceChildren(
    (() => {
      const allOption = document.createElement("option");
      allOption.value = "";
      allOption.textContent = "All tenants";
      return allOption;
    })(),
    ...state.tenants.map((tenant) => {
      const option = document.createElement("option");
      option.value = tenant.tenantId;
      option.textContent = tenant.name;
      return option;
    })
  );
}

async function bootstrap(): Promise<void> {
  state.templates = await fetchTemplates(apiBaseUrl);
  state.tenants = await listTenants(apiBaseUrl);
  state.rooms = await listRooms(apiBaseUrl);
  state.assets = await listAssets(apiBaseUrl);
  renderTenantOptions();
  templateSelect.replaceChildren(
    ...state.templates.map((template) => {
      const option = document.createElement("option");
      option.value = template.templateId;
      option.textContent = template.label;
      return option;
    })
  );
  state.selectedTemplate = state.templates[0];
  if (state.selectedTemplate) {
    templateSelect.value = state.selectedTemplate.templateId;
  }
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

templateSelect.addEventListener("change", () => {
  state.selectedTemplate = state.templates.find((template) => template.templateId === templateSelect.value);
  render();
});

roomFilterTenant.addEventListener("change", () => {
  state.roomFilterTenantId = roomFilterTenant.value || undefined;
  render();
});

form.addEventListener("submit", (event) => {
  event.preventDefault();
  state.publishStatus = "publishing";
  state.statusMessage = "publishing";
  render();
  void createRoom(apiBaseUrl, {
    tenantId: tenantSelect.value,
    templateId: templateSelect.value,
    name: roomNameInput.value,
    assetIds: Array.from(assetSelect.selectedOptions).map((option) => option.value),
    guestAllowed: guestAccessInput.checked,
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
    tenantId: tenantSelect.value,
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

updateAssetButton.addEventListener("click", () => {
  const assetId = state.selectedAsset?.assetId;
  if (!assetId) return;
  state.publishStatus = "publishing";
  state.statusMessage = "publishing";
  render();
  void updateAsset(apiBaseUrl, assetId, {
    tenantId: tenantSelect.value,
    kind: assetKindInput.value,
    url: assetUrlInput.value
  }, currentAuth())
    .then(async (asset) => {
      state.publishStatus = "published";
      state.statusMessage = "updated";
      state.assets = await listAssets(apiBaseUrl);
      state.selectedAsset = asset;
      assetSelect.replaceChildren(
        ...state.assets.map((item) => {
          const option = document.createElement("option");
          option.value = item.assetId;
          option.textContent = `${item.kind}: ${item.url}`;
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

deleteAssetButton.addEventListener("click", () => {
  const assetId = state.selectedAsset?.assetId;
  if (!assetId) return;
  state.publishStatus = "publishing";
  state.statusMessage = "deleting";
  render();
  void deleteAsset(apiBaseUrl, assetId, currentAuth())
    .then(async () => {
      state.publishStatus = "published";
      state.statusMessage = "deleted";
      state.assets = await listAssets(apiBaseUrl);
      state.selectedAsset = undefined;
      assetKindInput.value = "logo";
      assetUrlInput.value = "https://example.com/logo.png";
      assetSelect.replaceChildren(
        ...state.assets.map((item) => {
          const option = document.createElement("option");
          option.value = item.assetId;
          option.textContent = `${item.kind}: ${item.url}`;
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

tenantForm.addEventListener("submit", (event) => {
  event.preventDefault();
  state.publishStatus = "publishing";
  state.statusMessage = "publishing";
  render();
  void createTenant(apiBaseUrl, { name: tenantNameInput.value }, currentAuth())
    .then(async (tenant) => {
      state.publishStatus = "published";
      state.statusMessage = "published";
      state.tenants = await listTenants(apiBaseUrl);
      renderTenantOptions();
      tenantSelect.value = tenant.tenantId;
      roomFilterTenant.value = tenant.tenantId;
      state.selectedTenant = tenant;
      tenantNameInput.value = tenant.name;
      render();
    })
    .catch(() => {
      state.publishStatus = "failed";
      state.statusMessage = "failed";
      render();
    });
});

updateTenantButton.addEventListener("click", () => {
  const tenantId = tenantSelect.value;
  if (!tenantId) return;
  state.publishStatus = "publishing";
  state.statusMessage = "publishing";
  render();
  void updateTenant(apiBaseUrl, tenantId, { name: tenantNameInput.value }, currentAuth())
    .then(async (tenant) => {
      state.publishStatus = "published";
      state.statusMessage = "updated";
      state.tenants = await listTenants(apiBaseUrl);
      state.selectedTenant = tenant;
      renderTenantOptions();
      tenantSelect.value = tenant.tenantId;
      roomFilterTenant.value = tenant.tenantId;
      render();
    })
    .catch(() => {
      state.publishStatus = "failed";
      state.statusMessage = "failed";
      render();
    });
});

deleteTenantButton.addEventListener("click", () => {
  const tenantId = tenantSelect.value;
  if (!tenantId) return;
  state.publishStatus = "publishing";
  state.statusMessage = "deleting";
  render();
  void deleteTenant(apiBaseUrl, tenantId, currentAuth())
    .then(async () => {
      state.publishStatus = "published";
      state.statusMessage = "deleted";
      state.tenants = await listTenants(apiBaseUrl);
      renderTenantOptions();
      state.selectedTenant = undefined;
      roomFilterTenant.value = "";
      tenantNameInput.value = "";
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

deleteRoomButton.addEventListener("click", () => {
  if (!state.selectedRoom) {
    return;
  }
  const roomId = state.selectedRoom.roomId;
  state.publishStatus = "publishing";
  state.statusMessage = "deleting";
  render();
  void deleteRoom(apiBaseUrl, roomId, currentAuth())
    .then(() => {
      state.publishStatus = "published";
      state.statusMessage = "deleted";
      state.roomLink = undefined;
      state.rooms = state.rooms.filter((room) => room.roomId !== roomId);
      state.selectedRoom = undefined;
      state.selectedRoomManifest = undefined;
      state.selectedRoomDiagnostics = [];
      render();
    })
    .catch(() => {
      state.publishStatus = "failed";
      state.statusMessage = "failed";
      render();
    });
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
    guestAllowed: guestAccessInput.checked,
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
