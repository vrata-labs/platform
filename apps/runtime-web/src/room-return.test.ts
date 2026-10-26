import assert from "node:assert/strict";
import test from "node:test";

import { createRoomReturnTab, parseRoomReturnUrls, planLeaveSpace } from "./room-return.js";

function memoryStorage(initial: Record<string, string> = {}) {
  const items = new Map(Object.entries(initial));
  return { items, getItem: (key: string) => items.get(key) ?? null, setItem: (key: string, value: string) => { items.set(key, value); },
    removeItem: (key: string) => { items.delete(key); } };
}

const urls = { ru: "https://vrataspace.ru/demos/meeting-room", en: "https://vrataspace.com/demos/meeting-room" };

test("only two https addresses are a way back", () => {
  assert.deepEqual(parseRoomReturnUrls(urls), urls);
  for (const value of [null, "https://vrataspace.ru/", [], { ru: urls.ru }, { ...urls, en: "http://vrataspace.com/" }, { ...urls, ru: "javascript:alert(1)" },
    { ...urls, ru: "//evil.test/" }, { ...urls, en: "https://user:pass@vrataspace.com/" }, { ru: 1, en: 2 }]) {
    assert.equal(parseRoomReturnUrls(value), null, JSON.stringify(value));
  }
});

test("the tab keeps the way back of its room across a reload and ignores a broken record", () => {
  const storage = memoryStorage();
  const tab = createRoomReturnTab(storage, "room-1");
  assert.equal(tab.urlFor("ru"), null);
  tab.remember({ ru: "ftp://x" });
  assert.deepEqual([storage.items.size, tab.urlFor("ru")], [0, null], "an invalid way back is not stored");
  tab.remember(urls);
  assert.equal(tab.urlFor("en"), urls.en);
  const reloaded = createRoomReturnTab(storage, "room-1");
  assert.equal(reloaded.urlFor("ru"), urls.ru);
  assert.equal(createRoomReturnTab(storage, "room-2").urlFor("ru"), null, "another room has its own way back");
  reloaded.remember(undefined);
  assert.deepEqual([reloaded.urlFor("ru"), storage.items.has("vrata.return.room-1")], [null, false], "a new exchange without a way back clears the old one");
  assert.equal(createRoomReturnTab(memoryStorage({ "vrata.return.room-1": "{broken" }), "room-1").urlFor("ru"), null);
  assert.equal(createRoomReturnTab(memoryStorage({ "vrata.return.room-1": JSON.stringify({ ru: "http://a.test/", en: urls.en }) }), "room-1").urlFor("en"), null);
  const denied = { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("denied"); }, removeItem: () => { throw new Error("denied"); } };
  const pageOnly = createRoomReturnTab(denied, "room-1");
  pageOnly.remember(urls);
  assert.equal(pageOnly.urlFor("ru"), urls.ru, "a storage-denied tab keeps it for the page");
});

test("leaving ends XR first, removes presence while admitted, stops the session and then goes back or shows the left screen", () => {
  assert.deepEqual(planLeaveSpace({ xrPresenting: true, admitted: true, returnUrl: urls.ru }), ["end_xr", "remove_presence", "stop_session", "navigate"]);
  assert.deepEqual(planLeaveSpace({ xrPresenting: false, admitted: true, returnUrl: null }), ["remove_presence", "stop_session", "show_left"]);
  assert.deepEqual(planLeaveSpace({ xrPresenting: false, admitted: false, returnUrl: urls.en }), ["stop_session", "navigate"]);
});
