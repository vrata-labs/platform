import assert from "node:assert/strict";
import test from "node:test";

import { currentLocale, onLocaleChange, readLocaleCookie, renderText, resolveRuntimeLocale, setLocale, t } from "./i18n.js";
import { EN, RU } from "./messages.js";

test("both dictionaries have the same keys, no empty text and the same placeholders", () => {
  assert.deepEqual(Object.keys(RU).sort(), Object.keys(EN).sort());
  for (const key of Object.keys(EN) as Array<keyof typeof EN>) {
    assert.ok(EN[key].trim() && RU[key].trim(), key);
    const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
    assert.deepEqual(placeholders(RU[key]), placeholders(EN[key]), key);
  }
});

test("the language comes from the tab choice, then ?lang, then the portal cookie, then the browser, else English", () => {
  const base = { stored: null, query: null, cookie: "", languages: [] as string[] };
  assert.equal(resolveRuntimeLocale(base), "en");
  assert.equal(resolveRuntimeLocale({ ...base, languages: ["de-DE", "ru-RU", "en"] }), "ru");
  assert.equal(resolveRuntimeLocale({ ...base, cookie: "a=1; vrata-locale=en", languages: ["ru-RU"] }), "en");
  assert.equal(resolveRuntimeLocale({ ...base, query: "RU", cookie: "vrata-locale=en" }), "ru");
  assert.equal(resolveRuntimeLocale({ ...base, stored: "en", query: "ru", cookie: "vrata-locale=ru", languages: ["ru"] }), "en");
  assert.equal(resolveRuntimeLocale({ ...base, stored: "de", query: "fr", cookie: "vrata-locale=xx", languages: ["ru"] }), "ru", "unknown values are skipped");
  assert.equal(readLocaleCookie("other-vrata-locale=en; vrata-locale=ru"), "ru");
  assert.equal(readLocaleCookie("vrata-locale-x=ru"), null);
});

test("a switch renders texts in the new language and tells the listeners once", () => {
  const seen: string[] = [];
  const stop = onLocaleChange((locale) => seen.push(locale));
  try {
    assert.equal(currentLocale(), "en");
    assert.equal(t("status.joinedAs", { name: "Ann" }), "Joined as Ann");
    setLocale("ru");
    setLocale("ru");
    assert.equal(t("status.joinedAs", { name: "Аня" }), "Вы вошли как Аня");
    assert.equal(renderText({ key: "leave.button" }), "Покинуть пространство");
    assert.equal(renderText("plain"), "plain");
    assert.equal(t("access.request", { message: "x" }), "x. Запрос: {requestId}", "a missing parameter stays visible");
    assert.deepEqual(seen, ["ru"]);
  } finally {
    setLocale("en");
    stop();
  }
});
