import {
  createSceneBundleVersion,
  bindRoomSceneBundle,
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
  listSceneBundleVersions,
  listSceneBundles,
  setCurrentSceneBundleVersion,
  listRooms,
  listTenants,
  updateSceneBundleVersionStatus,
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
const assetProcessedUrlInput = mustElement<HTMLInputElement>("#asset-processed-url-input");
const assetStatusSelect = mustElement<HTMLSelectElement>("#asset-status-select");
const updateAssetButton = mustElement<HTMLButtonElement>("#update-asset");
const deleteAssetButton = mustElement<HTMLButtonElement>("#delete-asset");
const templateSelect = mustElement<HTMLSelectElement>("#template-select");
const assetSelect = mustElement<HTMLSelectElement>("#asset-select");
const sceneBundleSelect = mustElement<HTMLSelectElement>("#scene-bundle-select");
const sceneBundleVersionSelect = mustElement<HTMLSelectElement>("#scene-bundle-version-select");
const sceneBundleForm = mustElement<HTMLFormElement>("#scene-bundle-form");
const sceneBundleIdInput = mustElement<HTMLInputElement>("#scene-bundle-id-input");
const sceneBundleVersionInput = mustElement<HTMLInputElement>("#scene-bundle-version-input");
const sceneBundleStorageKeyInput = mustElement<HTMLInputElement>("#scene-bundle-storage-key-input");
const primaryColorInput = mustElement<HTMLInputElement>("#primary-color-input");
const accentColorInput = mustElement<HTMLInputElement>("#accent-color-input");
const featureVoiceInput = mustElement<HTMLInputElement>("#feature-voice-input");
const featureSpatialInput = mustElement<HTMLInputElement>("#feature-spatial-input");
const featureShareInput = mustElement<HTMLInputElement>("#feature-share-input");
const guestAccessInput = mustElement<HTMLInputElement>("#guest-access-input");
const avatarEnabledInput = mustElement<HTMLInputElement>("#avatar-enabled-input");
const avatarCatalogUrlInput = mustElement<HTMLInputElement>("#avatar-catalog-url-input");
const avatarQualitySelect = mustElement<HTMLSelectElement>("#avatar-quality-select");
const avatarFallbackInput = mustElement<HTMLInputElement>("#avatar-fallback-input");
const avatarSeatsInput = mustElement<HTMLInputElement>("#avatar-seats-input");
const updateRoomButton = mustElement<HTMLButtonElement>("#update-room");
const deleteRoomButton = mustElement<HTMLButtonElement>("#delete-room");
const publishStatus = mustElement<HTMLDivElement>("#publish-status");
const roomLink = mustElement<HTMLAnchorElement>("#room-link");
const refreshRoomDetailButton = mustElement<HTMLButtonElement>("#refresh-room-detail");
const bindSceneBundleButton = mustElement<HTMLButtonElement>("#bind-scene-bundle");
const setCurrentSceneBundleButton = mustElement<HTMLButtonElement>("#set-current-scene-bundle");
const markSceneBundleObsoleteButton = mustElement<HTMLButtonElement>("#mark-scene-bundle-obsolete");
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
        selectedSceneBundle: state.selectedSceneBundle,
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
      selectButton.textContent = `${asset.kind}: ${asset.url} -> ${asset.processedUrl ?? asset.url} [${asset.validationStatus ?? "validated"}]`;
      selectButton.addEventListener("click", () => {
        state.selectedAsset = asset;
        assetKindInput.value = asset.kind;
        assetUrlInput.value = asset.url;
        assetProcessedUrlInput.value = asset.processedUrl ?? asset.url;
        assetStatusSelect.value = asset.validationStatus ?? "validated";
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
  state.selectedSceneBundle = state.sceneBundles.find((bundle) => bundle.publicUrl === state.selectedRoomManifest?.sceneBundle?.url);
  state.sceneBundleVersions = state.selectedSceneBundle ? await listSceneBundleVersions(apiBaseUrl, state.selectedSceneBundle.bundleId).catch(() => []) : [];
  roomNameInput.value = room.name;
  templateSelect.value = room.templateId;
  primaryColorInput.value = room.theme?.primaryColor ?? "#5fc8ff";
  accentColorInput.value = room.theme?.accentColor ?? "#163354";
  featureVoiceInput.checked = room.features?.voice ?? true;
  featureSpatialInput.checked = room.features?.spatialAudio ?? true;
  featureShareInput.checked = room.features?.screenShare ?? true;
  guestAccessInput.checked = room.guestAllowed ?? state.selectedRoomManifest?.access.guestAllowed ?? true;
  avatarEnabledInput.checked = room.avatarConfig?.avatarsEnabled ?? state.selectedRoomManifest?.avatars?.avatarsEnabled ?? false;
  avatarCatalogUrlInput.value = room.avatarConfig?.avatarCatalogUrl ?? state.selectedRoomManifest?.avatars?.avatarCatalogUrl ?? "/assets/avatars/catalog.v1.json";
  avatarQualitySelect.value = room.avatarConfig?.avatarQualityProfile ?? state.selectedRoomManifest?.avatars?.avatarQualityProfile ?? "desktop-standard";
  avatarFallbackInput.checked = room.avatarConfig?.avatarFallbackCapsulesEnabled ?? state.selectedRoomManifest?.avatars?.avatarFallbackCapsulesEnabled ?? true;
  avatarSeatsInput.checked = room.avatarConfig?.avatarSeatsEnabled ?? state.selectedRoomManifest?.avatars?.avatarSeatsEnabled ?? false;
  const assetIds = new Set(room.assetIds ?? []);
  Array.from(assetSelect.options).forEach((option) => {
    option.selected = assetIds.has(option.value);
  });
  sceneBundleSelect.value = state.selectedSceneBundle?.bundleId ?? "";
  sceneBundleVersionSelect.replaceChildren(
    (() => {
      const option = document.createElement("option");
      option.value = "";
      option.textContent = "Current version";
      return option;
    })(),
    ...state.sceneBundleVersions.map((bundle) => {
      const option = document.createElement("option");
      option.value = bundle.version;
      option.textContent = `${bundle.version}${bundle.isCurrent ? " [current]" : ""}${bundle.status ? ` [${bundle.status}]` : ""}`;
      return option;
    })
  );
  sceneBundleVersionSelect.value = state.selectedSceneBundle?.version ?? "";
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

function collectAvatarConfig(): {
  avatarsEnabled: boolean;
  avatarCatalogUrl?: string;
  avatarQualityProfile: "mobile-lite" | "desktop-standard" | "xr";
  avatarFallbackCapsulesEnabled: boolean;
  avatarSeatsEnabled: boolean;
} {
  return {
    avatarsEnabled: avatarEnabledInput.checked,
    avatarCatalogUrl: avatarCatalogUrlInput.value.trim() || undefined,
    avatarQualityProfile: avatarQualitySelect.value as "mobile-lite" | "desktop-standard" | "xr",
    avatarFallbackCapsulesEnabled: avatarFallbackInput.checked,
    avatarSeatsEnabled: avatarSeatsInput.checked
  };
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
  state.sceneBundles = await listSceneBundles(apiBaseUrl).catch(() => []);
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
  sceneBundleSelect.replaceChildren(
    (() => {
      const option = document.createElement("option");
      option.value = "";
      option.textContent = "No registered bundle";
      return option;
    })(),
    ...state.sceneBundles.map((bundle) => {
      const option = document.createElement("option");
      option.value = bundle.bundleId;
      option.textContent = `${bundle.bundleId} (${bundle.version})`;
      return option;
    })
  );
  if (state.sceneBundles[0]) {
    sceneBundleIdInput.value = state.sceneBundles[0].bundleId;
  }
  render();
  startSelectedRoomPolling();
}

sceneBundleSelect.addEventListener("change", () => {
  const selected = state.sceneBundles.find((bundle) => bundle.bundleId === sceneBundleSelect.value);
  state.selectedSceneBundle = selected;
  sceneBundleIdInput.value = selected?.bundleId ?? sceneBundleIdInput.value;
  if (!selected) {
    state.sceneBundleVersions = [];
    sceneBundleVersionSelect.replaceChildren();
    render();
    return;
  }
  void listSceneBundleVersions(apiBaseUrl, selected.bundleId)
    .then((versions) => {
      state.sceneBundleVersions = versions;
      sceneBundleVersionSelect.replaceChildren(
        ...versions.map((bundle) => {
          const option = document.createElement("option");
          option.value = bundle.version;
          option.textContent = `${bundle.version}${bundle.isCurrent ? " [current]" : ""}${bundle.status ? ` [${bundle.status}]` : ""}`;
          return option;
        })
      );
      sceneBundleVersionSelect.value = selected.version;
      render();
    })
    .catch((error: unknown) => {
      state.publishStatus = "failed";
      state.statusMessage = error instanceof Error ? `failed:${error.message}` : "failed";
      render();
    });
});

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
    avatarConfig: collectAvatarConfig(),
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
    .catch((error: unknown) => {
      state.publishStatus = "failed";
      state.statusMessage = error instanceof Error ? `failed:${error.message}` : "failed";
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
    url: assetUrlInput.value,
    processedUrl: assetProcessedUrlInput.value,
    validationStatus: assetStatusSelect.value as "pending" | "validated" | "rejected"
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
    url: assetUrlInput.value,
    processedUrl: assetProcessedUrlInput.value,
    validationStatus: assetStatusSelect.value as "pending" | "validated" | "rejected"
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
      assetProcessedUrlInput.value = "https://cdn.example.com/logo.glb";
      assetStatusSelect.value = "validated";
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

bindSceneBundleButton.addEventListener("click", () => {
  if (!state.selectedRoom || !sceneBundleSelect.value) {
    return;
  }
  state.publishStatus = "publishing";
  state.statusMessage = "binding-scene-bundle";
  render();
  void bindRoomSceneBundle(apiBaseUrl, state.selectedRoom.roomId, sceneBundleSelect.value, currentAuth(), sceneBundleVersionSelect.value || undefined)
    .then(async (room) => {
      state.publishStatus = "published";
      state.statusMessage = "scene-bundle-bound";
      state.rooms = state.rooms.map((item) => item.roomId === room.roomId ? room : item);
      await selectRoom(room);
    })
    .catch((error: unknown) => {
      state.publishStatus = "failed";
      state.statusMessage = error instanceof Error ? `failed:${error.message}` : "failed";
      render();
    });
});

sceneBundleForm.addEventListener("submit", (event) => {
  event.preventDefault();
  state.publishStatus = "publishing";
  state.statusMessage = "publishing-scene-bundle-version";
  render();
  void createSceneBundleVersion(apiBaseUrl, sceneBundleIdInput.value.trim(), {
    version: sceneBundleVersionInput.value.trim(),
    storageKey: sceneBundleStorageKeyInput.value.trim()
  }, currentAuth())
    .then(async () => {
      state.publishStatus = "published";
      state.statusMessage = "scene-bundle-version-created";
      state.sceneBundles = await listSceneBundles(apiBaseUrl);
      render();
    })
    .catch((error: unknown) => {
      state.publishStatus = "failed";
      state.statusMessage = error instanceof Error ? `failed:${error.message}` : "failed";
      render();
    });
});

setCurrentSceneBundleButton.addEventListener("click", () => {
  if (!sceneBundleSelect.value || !sceneBundleVersionSelect.value) return;
  state.publishStatus = "publishing";
  state.statusMessage = "setting-current-scene-bundle-version";
  render();
  void setCurrentSceneBundleVersion(apiBaseUrl, sceneBundleSelect.value, sceneBundleVersionSelect.value, currentAuth())
    .then(async () => {
      state.publishStatus = "published";
      state.statusMessage = "scene-bundle-current-updated";
      state.sceneBundles = await listSceneBundles(apiBaseUrl);
      state.sceneBundleVersions = await listSceneBundleVersions(apiBaseUrl, sceneBundleSelect.value);
      render();
    })
    .catch((error: unknown) => {
      state.publishStatus = "failed";
      state.statusMessage = error instanceof Error ? `failed:${error.message}` : "failed";
      render();
    });
});

markSceneBundleObsoleteButton.addEventListener("click", () => {
  if (!sceneBundleSelect.value || !sceneBundleVersionSelect.value) return;
  state.publishStatus = "publishing";
  state.statusMessage = "marking-scene-bundle-obsolete";
  render();
  void updateSceneBundleVersionStatus(apiBaseUrl, sceneBundleSelect.value, sceneBundleVersionSelect.value, "obsolete", currentAuth())
    .then(async () => {
      state.publishStatus = "published";
      state.statusMessage = "scene-bundle-version-obsolete";
      state.sceneBundleVersions = await listSceneBundleVersions(apiBaseUrl, sceneBundleSelect.value);
      render();
    })
    .catch((error: unknown) => {
      state.publishStatus = "failed";
      state.statusMessage = error instanceof Error ? `failed:${error.message}` : "failed";
      render();
    });
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
    avatarConfig: collectAvatarConfig(),
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
    .catch((error: unknown) => {
      state.publishStatus = "failed";
      state.statusMessage = error instanceof Error ? `failed:${error.message}` : "failed";
      render();
    });
});

void bootstrap();
