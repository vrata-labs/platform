import assert from "node:assert/strict";
import test from "node:test";

import { parseReturnTargets, resolveReturnUrls } from "./return-targets.js";

const targets = parseReturnTargets(JSON.stringify({
  "catalog-entry": { ru: "https://ru.example.test/demos/{id}", en: "https://en.example.test/demos/{id}" },
  order: { ru: "https://app.example.test/app/orders/{id}?from=room", en: "https://app.example.test/app/orders/{id}?from=room" },
  fallback: { ru: "https://ru.example.test/", en: "https://en.example.test/" }
}));

test("a return context becomes the configured page in both languages, anything else the fallback", () => {
  assert.deepEqual(resolveReturnUrls(targets, { kind: "catalog-entry", id: "meeting-room", locale: "ru" }),
    { ru: "https://ru.example.test/demos/meeting-room", en: "https://en.example.test/demos/meeting-room" });
  assert.deepEqual(resolveReturnUrls(targets, { kind: "order", id: "ord_01", locale: "en" }),
    { ru: "https://app.example.test/app/orders/ord_01?from=room", en: "https://app.example.test/app/orders/ord_01?from=room" });
  const fallback = { ru: "https://ru.example.test/", en: "https://en.example.test/" };
  for (const context of [null, undefined, "catalog-entry", { kind: "space", id: "s1", locale: "ru" }, { kind: "catalog-entry", id: "../x", locale: "ru" },
    { kind: "catalog-entry", id: "a/b", locale: "ru" }, { kind: "catalog-entry", id: 7, locale: "ru" }, { kind: "fallback", id: "x" }]) {
    assert.deepEqual(resolveReturnUrls(targets, context), fallback, JSON.stringify(context));
  }
  const noFallback = parseReturnTargets(JSON.stringify({ "catalog-entry": { ru: "https://ru.example.test/demos/{id}", en: "https://en.example.test/demos/{id}" } }));
  assert.equal(resolveReturnUrls(noFallback, { kind: "space", id: "s1", locale: "ru" }), null);
  assert.equal(resolveReturnUrls(parseReturnTargets(undefined), { kind: "catalog-entry", id: "meeting-room", locale: "ru" }), null);
  assert.equal(parseReturnTargets(" ").size, 0);
});

test("the allowlist takes only https templates whose id changes nothing but the path", () => {
  const entry = (template: string, en = "https://en.example.test/") => JSON.stringify({ "catalog-entry": { ru: template, en } });
  for (const [raw, reason] of [
    ["{", "json"],
    ["[]", "not_object"],
    [JSON.stringify({ url: { ru: "https://a.test/", en: "https://a.test/" } }), "kind:url"],
    [JSON.stringify({ "catalog-entry": { ru: "https://a.test/" } }), "locales:catalog-entry"],
    [JSON.stringify({ "catalog-entry": { ru: "https://a.test/", en: "https://a.test/", de: "https://a.test/" } }), "locales:catalog-entry"],
    [entry("http://ru.example.test/demos/{id}"), "url:catalog-entry:ru"],
    [entry("javascript:alert(1)//{id}"), "url:catalog-entry:ru"],
    [entry("https://user:pass@ru.example.test/{id}"), "url:catalog-entry:ru"],
    [entry("/demos/{id}"), "url:catalog-entry:ru"],
    [entry("https://{id}.example.test/"), "id:catalog-entry:ru"],
    [entry("https://ru.example.test{id}/"), "id:catalog-entry:ru"],
    [entry("https://ru.example.test/?next={id}"), "id:catalog-entry:ru"],
    [entry("https://ru.example.test/#{id}"), "id:catalog-entry:ru"],
    [entry("https://ru.example.test/{id}/{id}"), "id:catalog-entry:ru"],
    [entry("https://ru.example.test/" + "x".repeat(512)), "template:catalog-entry:ru"],
    [JSON.stringify({ fallback: { ru: "https://ru.example.test/{id}", en: "https://en.example.test/" } }), "id:fallback:ru"],
    [JSON.stringify({ fallback: { ru: 5, en: "https://en.example.test/" } }), "template:fallback:ru"]
  ]) {
    assert.throws(() => parseReturnTargets(raw), new RegExp(`^Error: invalid_return_targets:${reason.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`), raw);
  }
  assert.equal(parseReturnTargets(entry("https://ru.example.test/demos/{id}/")).size, 1);
});
