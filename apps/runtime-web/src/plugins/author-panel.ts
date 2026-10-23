import { ROOM_PLUGIN_LIMITS, type RoomPluginCapability, type RoomPluginConfigField } from "@vrata/room-plugin-sdk";
import type { RoomPluginAuthorPackage } from "./author-http.js";
import { initialRoomPluginApproval, initialRoomPluginConfigForm, readRoomPluginConfigForm, roomPluginAuthorEntries,
  roomPluginPackageSelectable, roomPluginPackageUsable, ROOM_PLUGIN_CAPABILITY_LABELS, type RoomPluginAuthorEntry,
  type RoomPluginAuthorIntent } from "./author-model.js";
import type { RoomPluginAuthorState } from "./author-session.js";

/** basis is the binding state the draft was made from; any other write to this binding discards it. */
interface Draft { basis: string; packageId: string; approved: Set<RoomPluginCapability>; form: Record<string, string | boolean> }
const basisOf = (entry: RoomPluginAuthorEntry) => entry.binding ? `${entry.binding.bindingRevision}` : "unbound";
type Elements = {
  root: HTMLElement; list: HTMLElement; message: HTMLElement;
  fileInput: HTMLInputElement; uploadButton: HTMLButtonElement;
};

/** Text-only author view: package names, versions and config values are never parsed as HTML.
 * Form drafts survive refreshes until their selected version disappears. */
export function createRoomPluginAuthorPanel(input: Elements & {
  document: Document;
  upload(bytes: Uint8Array): Promise<void>;
  apply(intent: RoomPluginAuthorIntent): Promise<void>;
}) {
  const { document } = input;
  const drafts = new Map<string, Draft>();
  let state: RoomPluginAuthorState | null = null, previous = "", reading = false;
  let local: RoomPluginAuthorState["message"] = null;

  const element = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, className?: string) => {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (className) node.className = className;
    return node;
  };
  const writable = () => Boolean(state && state.phase === "ready" && !state.frozen && !state.busy && !reading);

  function draft(entry: RoomPluginAuthorEntry): Draft | null {
    const selectable = entry.versions.filter(roomPluginPackageSelectable);
    let current = drafts.get(entry.pluginId);
    // A concurrent write elsewhere must not be overwritten by values typed against the previous binding.
    if (current && (current.basis !== basisOf(entry) || !selectable.some(value => value.packageId === current!.packageId))) current = undefined;
    if (!current) {
      const selected = selectable.find(value => value.packageId === entry.binding?.packageId)
        ?? selectable.find(roomPluginPackageUsable) ?? selectable[0];
      if (!selected) { drafts.delete(entry.pluginId); return null; }
      current = { basis: basisOf(entry), packageId: selected.packageId, approved: new Set(initialRoomPluginApproval(entry, selected)),
        form: initialRoomPluginConfigForm(entry, selected.manifest.configSchema) };
      drafts.set(entry.pluginId, current);
    }
    return current;
  }
  function select(entry: RoomPluginAuthorEntry, value: RoomPluginAuthorPackage): void {
    const previousForm = drafts.get(entry.pluginId)?.form ?? {};
    const form = initialRoomPluginConfigForm(entry, value.manifest.configSchema);
    for (const key of Object.keys(form)) if (Object.hasOwn(previousForm, key) && typeof previousForm[key] === typeof form[key]) form[key] = previousForm[key];
    drafts.set(entry.pluginId, { basis: basisOf(entry), packageId: value.packageId, approved: new Set(initialRoomPluginApproval(entry, value)), form });
    paint(true);
  }

  function field(prefix: string, current: Draft, key: string, schema: RoomPluginConfigField): HTMLElement {
    const id = `${prefix}-config-${key}`;
    const wrapper = element("div", undefined, "room-plugin-author-field");
    const label = element("label", `${key}${schema.required ? " (required)" : ""}`); label.htmlFor = id;
    let control: HTMLInputElement | HTMLSelectElement;
    if (schema.type === "enum") {
      const choice = element("select"); choice.append(element("option", schema.required ? "Choose…" : "Not set"));
      (choice.firstChild as HTMLOptionElement).value = "";
      for (const value of schema.values) { const option = element("option", value); option.value = value; choice.append(option); }
      choice.value = String(current.form[key] ?? ""); control = choice;
    } else {
      const text = element("input");
      if (schema.type === "boolean") { text.type = "checkbox"; text.checked = current.form[key] === true; }
      else if (schema.type === "number") { text.type = "number"; text.min = String(schema.minimum); text.max = String(schema.maximum); text.step = "any"; text.value = String(current.form[key] ?? ""); }
      else { text.type = "text"; text.maxLength = schema.maxLength; text.value = String(current.form[key] ?? ""); }
      control = text;
    }
    control.id = id; control.dataset.configKey = key; control.disabled = !writable();
    control.addEventListener(schema.type === "boolean" || schema.type === "enum" ? "change" : "input", () => {
      current.form[key] = control instanceof HTMLInputElement && control.type === "checkbox" ? control.checked : control.value;
    });
    if (schema.type === "boolean") wrapper.append(control, label); else wrapper.append(label, control);
    return wrapper;
  }

  function button(text: string, action: string, intent: () => RoomPluginAuthorIntent, disabled = false): HTMLButtonElement {
    const node = element("button", text); node.type = "button"; node.dataset.action = action; node.disabled = disabled || !writable();
    node.addEventListener("click", () => { if (writable()) void input.apply(intent()); });
    return node;
  }

  function entryView(entry: RoomPluginAuthorEntry, index: number): HTMLElement {
    // Indexed ids: distinct plugin IDs never collide after character replacement.
    const prefix = `room-plugin-author-${index}`;
    const article = element("article", undefined, "room-plugin-author-entry"); article.dataset.pluginId = entry.pluginId;
    article.append(element("h3", entry.displayName));
    const binding = entry.binding;
    article.append(element("p", `${entry.pluginId} · ${binding ? `${binding.enabled ? "Enabled" : "Disabled"}, version ${binding.version}` : "Not enabled in this room"}`,
      "audio-device-status room-plugin-author-state"));
    const current = draft(entry);
    if (!current) { article.append(element("p", "No stored version is ready yet.", "audio-device-status")); return article; }
    const selected = entry.versions.find(value => value.packageId === current.packageId)!;
    const versionId = `${prefix}-version`;
    const versionLabel = element("label", "Version"); versionLabel.htmlFor = versionId;
    const versions = element("select"); versions.id = versionId; versions.dataset.role = "version"; versions.disabled = !writable();
    for (const value of entry.versions) {
      const bound = value.packageId === binding?.packageId ? " · in use" : "";
      const option = element("option", `${value.version}${bound} · ${Math.max(1, Math.round(value.byteLength / 1024))} KiB · sha256 ${value.artifactSha256.slice(0, 12)}…`);
      if (value.state === "cleanup-pending") option.textContent += " · deletion pending";
      option.value = value.packageId; option.disabled = !roomPluginPackageSelectable(value); versions.append(option);
    }
    versions.value = current.packageId;
    versions.addEventListener("change", () => {
      const value = entry.versions.find(item => item.packageId === versions.value); if (value) select(entry, value);
    });
    article.append(versionLabel, versions);

    const permissions = element("fieldset", undefined, "room-plugin-author-permissions");
    permissions.append(element("legend", "Permissions requested by this exact version"));
    if (!selected.manifest.requestedCapabilities.length) permissions.append(element("p", "No room permissions requested.", "audio-device-status"));
    for (const capability of selected.manifest.requestedCapabilities) {
      const row = element("label", undefined, "room-plugin-author-capability");
      const box = element("input"); box.type = "checkbox"; box.dataset.capability = capability; box.checked = current.approved.has(capability); box.disabled = !writable();
      box.addEventListener("change", () => { if (box.checked) current.approved.add(capability); else current.approved.delete(capability); });
      row.append(box, document.createTextNode(` ${ROOM_PLUGIN_CAPABILITY_LABELS[capability]} (${capability})`));
      if (binding && !binding.approvedCapabilities.includes(capability)) row.append(element("strong", " New for this room"));
      permissions.append(row);
    }
    article.append(permissions);

    const schema = Object.entries(selected.manifest.configSchema).slice(0, ROOM_PLUGIN_LIMITS.configFields);
    if (schema.length) {
      const settings = element("fieldset", undefined, "room-plugin-author-settings"); settings.append(element("legend", "Settings"));
      for (const [key, value] of schema) settings.append(field(prefix, current, key, value));
      article.append(settings);
    }

    const actions = element("div", undefined, "controls compact-controls");
    const sameVersion = binding?.packageId === selected.packageId;
    const enable = () => ({ type: "enable" as const, pluginId: entry.pluginId, packageId: selected.packageId, approved: [...current.approved],
      config: readRoomPluginConfigForm(selected.manifest.configSchema, current.form) });
    actions.append(button(binding?.enabled ? sameVersion ? "Apply settings" : `Switch to version ${selected.version}` : `Enable version ${selected.version}`, "enable", enable,
      !roomPluginPackageUsable(selected)));
    if (binding?.enabled) actions.append(button("Disable", "disable", () => ({ type: "disable", pluginId: entry.pluginId })));
    if (binding && !binding.enabled) actions.append(button("Remove from room", "unbind", () => ({ type: "unbind", pluginId: entry.pluginId })));
    if (!sameVersion) actions.append(button(`${selected.state === "cleanup-pending" ? "Retry deleting" : "Delete"} version ${selected.version}`, "delete",
      () => ({ type: "delete", packageId: selected.packageId })));
    article.append(actions);
    return article;
  }

  function paint(force = false): void {
    const current = state;
    if (!current) return;
    input.root.hidden = current.phase === "hidden";
    const message = local ?? current.message;
    input.message.textContent = message?.text ?? (current.phase === "loading" ? "Loading room behaviors…" : current.busy || reading ? "Saving…" : "");
    input.message.dataset.kind = message?.kind ?? "";
    input.root.setAttribute("aria-busy", String(Boolean(current.busy) || current.phase === "loading"));
    input.uploadButton.disabled = !writable() || !input.fileInput.files?.length;
    input.fileInput.disabled = !writable();
    const key = JSON.stringify([current.library, current.busy, current.frozen, current.phase, reading]);
    if (!force && key === previous) return;
    previous = key;
    const entries = current.library ? roomPluginAuthorEntries(current.library) : [];
    for (const id of [...drafts.keys()]) if (!entries.some(entry => entry.pluginId === id)) drafts.delete(id);
    input.list.replaceChildren(...(entries.length ? entries.map((entry, index) => entryView(entry, index))
      : current.phase === "ready" ? [element("p", "No packages uploaded to this room yet.", "audio-device-status")] : []));
  }

  input.fileInput.addEventListener("change", () => paint());
  input.uploadButton.addEventListener("click", () => {
    const file = input.fileInput.files?.[0];
    if (!file || !writable()) return;
    reading = true; paint(true);
    void (async () => {
      let bytes: Uint8Array | null = null;
      try { if (file.size <= ROOM_PLUGIN_LIMITS.artifactBytes) bytes = new Uint8Array(await file.arrayBuffer()); }
      catch { bytes = null; }
      finally { reading = false; }
      if (!bytes) {
        local = { kind: "error", text: file.size > ROOM_PLUGIN_LIMITS.artifactBytes ? "The package is larger than 1 MiB." : "The selected file could not be read." };
        paint(true); return;
      }
      await input.upload(bytes);
      input.fileInput.value = "";
      paint(true);
    })();
  });

  return {
    render(next: RoomPluginAuthorState): void { state = next; local = null; paint(); }
  };
}
