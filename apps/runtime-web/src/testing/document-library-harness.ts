import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import type { RoomPermission } from "@vrata/shared-types";
import { createDocumentLibraryRuntime, type DocumentLibraryContext } from "../document-library-runtime.js";
import type { RuntimeDocumentRecord } from "../index.js";
import { DocumentTestElement, installDocumentTestDom } from "./document-ui-dom.js";
import { makeDocument } from "./document-surface-actions-harness.js";

type Services = Pick<DocumentLibraryContext,
  "listRoomDocuments" | "uploadRoomDocument" | "downloadRoomDocument" | "deleteRoomDocument" | "probeDocumentMedia"
>;

export function createDocumentLibraryHarness(t: TestContext) {
  const dom = installDocumentTestDom(t);
  const events: Array<{ name: string; args: unknown[] }> = [];
  const hooks: Partial<Services> = {};
  const log = (name: string, ...args: unknown[]) => { events.push({ name, args }); };
  const permissions: RoomPermission[] = ["document.view", "document.upload", "document.download", "document.delete", "document.present"];
  const context = {
    apiBaseUrl: "https://example.invalid", roomId: "room", roomStateAccessToken: "token-1",
    runtimeFlags: { documentsEnabled: true as boolean }, roomStateConnected: true as boolean,
    presentationActionInFlight: false as boolean, roomDocuments: [] as RuntimeDocumentRecord[], selectedDocumentId: "",
    debugState: { access: { permissions }, documents: {
      enabled: true, count: 0, selectedDocumentId: "", selectedFilename: null as string | null,
      selectedSurfaceId: null as string | null, lastStatus: "initial", errorCode: null as string | null
    } },
    documentsPanelEl: new DocumentTestElement(), documentUploadInput: new DocumentTestElement("input"),
    documentUploadButton: new DocumentTestElement("button"), documentSelect: new DocumentTestElement("select"),
    documentDownloadButton: new DocumentTestElement("button"), documentSurfaceButton: new DocumentTestElement("button"),
    documentDeleteButton: new DocumentTestElement("button"), documentStatusEl: new DocumentTestElement(),
    renderPresentationControls() { log("presentation", context.presentationActionInFlight); },
    renderDocumentMediaControls() { log("media", context.presentationActionInFlight); },
    listRoomDocuments: async function (this: unknown, ...args: Parameters<Services["listRoomDocuments"]>) {
      assert.equal(this, undefined); log("list", ...args);
      return hooks.listRoomDocuments ? hooks.listRoomDocuments(...args) : [];
    },
    uploadRoomDocument: async function (this: unknown, ...args: Parameters<Services["uploadRoomDocument"]>) {
      assert.equal(this, undefined); log("upload", ...args);
      return hooks.uploadRoomDocument ? hooks.uploadRoomDocument(...args) : makeDocument("pdf", "uploaded");
    },
    downloadRoomDocument: async function (this: unknown, ...args: Parameters<Services["downloadRoomDocument"]>) {
      assert.equal(this, undefined); log("download", ...args);
      return hooks.downloadRoomDocument ? hooks.downloadRoomDocument(...args) : { blob: new Blob(["pdf"]), filename: "download.pdf" };
    },
    deleteRoomDocument: async function (this: unknown, ...args: Parameters<Services["deleteRoomDocument"]>) {
      assert.equal(this, undefined); log("delete", ...args);
      return hooks.deleteRoomDocument ? hooks.deleteRoomDocument(...args) : makeDocument("pdf");
    },
    probeDocumentMedia: async function (this: unknown, ...args: Parameters<Services["probeDocumentMedia"]>) {
      assert.equal(this, undefined); log("probe", ...args);
      return hooks.probeDocumentMedia ? hooks.probeDocumentMedia(...args) : null;
    }
  } satisfies DocumentLibraryContext;
  const runtime = createDocumentLibraryRuntime(context);
  return { dom, context, hooks, events, runtime,
    calls: (name: string) => events.filter((event) => event.name === name).map((event) => event.args) };
}
