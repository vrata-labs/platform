/*! SPDX-License-Identifier: Apache-2.0; Copyright 2026 Vrata contributors. License: https://www.apache.org/licenses/LICENSE-2.0 */
import type { RoomPluginContext, RoomPluginEvent, RoomPluginRoomSnapshot } from "@vrata/room-plugin-sdk";
import { nextCandidate } from "./candidates.js";

// Scaffold, not a seating authority. The broker owns readiness, XR/manual veto,
// grant expiry, real anchors, lease, cancellation correlation and confirmed pose.
let active = false;
let readinessSeen = false;
let ready = false;
let pending = false;
let waitingForFreshSnapshot = false;
let snapshot: RoomPluginRoomSnapshot | undefined;
let snapshotSequence = 0;
let claimSnapshotSequence = 0;
let runToken = 0;
let deadline = 0;
const attempted = new Set<string>();

async function status(context: RoomPluginContext, text: string): Promise<void> {
  try { await context.sdk.status.set(text); } catch { /* Unavailable broker: no action. */ }
}

async function finish(context: RoomPluginContext, text: string, cancelPending = false): Promise<void> {
  const cancel = pending && cancelPending;
  ready = false;
  pending = false;
  waitingForFreshSnapshot = false;
  runToken++;
  if (cancel) {
    try { await context.sdk.seating.cancelPendingOwnClaim(); } catch { /* No own pending authority. */ }
  }
  await status(context, text);
}

async function attempt(context: RoomPluginContext): Promise<void> {
  if (!active || !ready || pending || !snapshot) return;
  if (!snapshot.arrivalAllowed) return finish(context, "Автопосадка не разрешена. Используйте ручной выбор.", true);
  if (snapshot.seats.some(seat => seat.occupantAlias === snapshot!.ownParticipantAlias)) {
    return finish(context, "Ваше существующее место сохранено.");
  }
  if (Date.now() >= deadline) return finish(context, "Время автопосадки истекло. Сохранена точка входа.", true);
  if (waitingForFreshSnapshot && snapshotSequence <= claimSnapshotSequence) return;
  waitingForFreshSnapshot = false;
  if (attempted.size >= 8) return finish(context, "Лимит кандидатов исчерпан. Используйте ручной выбор.");
  const seatId = nextCandidate(snapshot, attempted);
  if (!seatId) return finish(context, "Свободных мест нет. Сохранена точка входа.");
  attempted.add(seatId);
  claimSnapshotSequence = snapshotSequence;
  pending = true;
  const token = runToken;
  try {
    const result = await context.sdk.seating.claimSelfOnEntry(seatId);
    if (!active || token !== runToken) return;
    pending = false;
    if (result === "accepted") return finish(context, "Заявка принята; посадку применяет платформа.");
    if (result === "busy") {
      waitingForFreshSnapshot = true;
      return attempt(context); // Waits for a post-claim snapshot; at most 8 different seats.
    }
    return finish(context, result === "offline" ? "Нет связи. Сохранена точка входа." : "Автопосадка отменена. Используйте ручной выбор.");
  } catch {
    if (!active || token !== runToken) return;
    // Unsupported/denied seating broker is not success and never grants itself authority.
    return finish(context, "Автопосадка недоступна. Используйте ручной выбор.", true);
  }
}

export function init(): void {
  active = true;
  readinessSeen = false;
  ready = false;
  pending = false;
  waitingForFreshSnapshot = false;
  snapshot = undefined;
  snapshotSequence = 0;
  attempted.clear();
  runToken++;
}

export async function onEvent(event: RoomPluginEvent, context: RoomPluginContext): Promise<void> {
  if (!active) return;
  if (event.type === "room.connection" && event.state !== "connected") {
    return finish(context, "Нет связи. Автопосадка остановлена.", true);
  }
  if (event.type === "lifecycle.dispose") return dispose(context);
  if (event.type === "room.ready" && !readinessSeen) {
    readinessSeen = true;
    snapshot = event.snapshot;
    snapshotSequence++;
    deadline = Date.now() + 5000;
    ready = snapshot.arrivalAllowed;
    if (!ready) return status(context, "Автопосадка не разрешена или не поддерживается. Используйте ручной выбор.");
  } else if (event.type === "seating.snapshot") {
    snapshot = event.snapshot;
    snapshotSequence++;
    if (!snapshot.arrivalAllowed && pending) return finish(context, "Начальная автопосадка отменена.", true);
  }
  return attempt(context);
}

export async function dispose(context: RoomPluginContext): Promise<void> {
  const cancel = pending;
  active = false;
  ready = false;
  pending = false;
  runToken++;
  if (cancel) {
    try { await context.sdk.seating.cancelPendingOwnClaim(); } catch { /* Does not release confirmed seats. */ }
  }
}
