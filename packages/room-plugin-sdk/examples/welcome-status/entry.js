/*! SPDX-License-Identifier: Apache-2.0; Copyright 2026 Vrata contributors. License: https://www.apache.org/licenses/LICENSE-2.0 */
// @ts-check
// This is already a single ES2020 module. JSDoc imports are erased, not runtime imports.

/** @param {import('@vrata/room-plugin-sdk').RoomPluginContext} context */
export function init(context) {
  return context.sdk.status.set("Welcome plugin initialized");
}

/**
 * @param {import('@vrata/room-plugin-sdk').RoomPluginEvent} event
 * @param {import('@vrata/room-plugin-sdk').RoomPluginContext} context
 */
export function onEvent(event, context) {
  if (event.type === "room.ready") {
    const greeting = typeof context.config["greeting"] === "string" ? context.config["greeting"] : "Welcome";
    return context.sdk.status.set(greeting);
  }
  if (event.type === "room.connection" && event.state !== "connected") {
    return context.sdk.status.set("Waiting for room connection");
  }
}

export function dispose() {
  // No native handles, timers or imports. The broker clears this plugin's status on dispose.
}
