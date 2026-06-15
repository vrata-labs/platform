#!/usr/bin/env node

const roomAliases = {
  blueoffice: "0b537d34-7b92-4b51-854a-8c64cfb4c114",
  hall: "42db8225-f671-4e46-9c28-9381d66a948c"
};

function parseArgs(argv) {
  const options = {
    baseUrl: process.env.BASE_URL ?? "https://158.160.10.234.sslip.io",
    adminToken: process.env.STAGING_ADMIN_TOKEN ?? process.env.NOAH_ADMIN_TOKEN ?? "noah-stage-admin",
    roomId: process.env.XR_ROOM_ID ?? roomAliases.blueoffice,
    includeSynthetic: false,
    watch: false,
    waitReal: false,
    timeoutMs: Number.parseInt(process.env.XR_TIMEOUT_MS ?? "60000", 10),
    intervalMs: Number.parseInt(process.env.XR_INTERVAL_MS ?? "2000", 10),
    historyLimit: Number.parseInt(process.env.XR_HISTORY_LIMIT ?? "12", 10),
    participantId: process.env.XR_PARTICIPANT_ID ?? null,
    json: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === "--") {
      continue;
    }
    if (arg === "--base-url" && next) {
      options.baseUrl = next;
      index += 1;
      continue;
    }
    if (arg === "--admin-token" && next) {
      options.adminToken = next;
      index += 1;
      continue;
    }
    if (arg === "--room-id" && next) {
      options.roomId = next;
      index += 1;
      continue;
    }
    if (arg === "--room" && next) {
      options.roomId = roomAliases[next.toLowerCase()] ?? next;
      index += 1;
      continue;
    }
    if (arg === "--participant" && next) {
      options.participantId = next;
      index += 1;
      continue;
    }
    if (arg === "--timeout-ms" && next) {
      options.timeoutMs = Number.parseInt(next, 10);
      index += 1;
      continue;
    }
    if (arg === "--interval-ms" && next) {
      options.intervalMs = Number.parseInt(next, 10);
      index += 1;
      continue;
    }
    if (arg === "--history-limit" && next) {
      options.historyLimit = Number.parseInt(next, 10);
      index += 1;
      continue;
    }
    if (arg === "--include-synthetic") {
      options.includeSynthetic = true;
      continue;
    }
    if (arg === "--watch") {
      options.watch = true;
      continue;
    }
    if (arg === "--wait-real") {
      options.waitReal = true;
      options.watch = true;
      continue;
    }
    if (arg === "--json") {
      options.json = true;
      continue;
    }
    if (arg === "--help") {
      printHelp();
      process.exit(0);
    }
    throw new Error(`unknown_argument:${arg}`);
  }

  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 0) {
    throw new Error("invalid_timeout_ms");
  }
  if (!Number.isFinite(options.intervalMs) || options.intervalMs <= 0) {
    throw new Error("invalid_interval_ms");
  }
  if (!Number.isFinite(options.historyLimit) || options.historyLimit <= 0) {
    throw new Error("invalid_history_limit");
  }

  return options;
}

function printHelp() {
  process.stdout.write([
    "Usage: pnpm xr:telemetry -- [options]",
    "",
    "Options:",
    "  --room <blueoffice|hall|room-id>",
    "  --room-id <uuid>",
    "  --participant <participant-id>",
    "  --base-url <https://...>",
    "  --admin-token <token>",
    "  --include-synthetic",
    "  --watch",
    "  --wait-real",
    "  --timeout-ms <ms>",
    "  --interval-ms <ms>",
    "  --history-limit <count>",
    "  --json",
    "  --help"
  ].join("\n") + "\n");
}

function round(value, digits = 3) {
  return typeof value === "number" && Number.isFinite(value) ? Number(value.toFixed(digits)) : null;
}

function formatNumber(value, digits = 2) {
  return typeof value === "number" && Number.isFinite(value) ? value.toFixed(digits) : "-";
}

function formatPoint(point) {
  if (!point) {
    return "-";
  }
  return `(${formatNumber(point.x)}, ${formatNumber(point.y)}, ${formatNumber(point.z)})`;
}

function formatTimestamp(value) {
  if (typeof value !== "string") {
    return "-";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toISOString().slice(11, 23);
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function hasNonZeroAxes(axes) {
  if (!axes) {
    return false;
  }
  return [axes.moveX, axes.moveY, axes.turnX, axes.turnY].some((value) => typeof value === "number" && Math.abs(value) > 0.01);
}

function hasRawInputActivity(inputs) {
  return Array.isArray(inputs) && inputs.some((input) =>
    input?.button0Pressed
    || input?.button1Pressed
    || (input?.axes ?? []).some((value) => typeof value === "number" && Math.abs(value) > 0.01)
  );
}

function rawProfiles(item) {
  return unique((item.xrRawInputs ?? []).flatMap((input) => input?.profiles ?? []));
}

function isSyntheticParticipant(item) {
  if (item.xrAvatarDebug?.profile === "synthetic") {
    return true;
  }
  return rawProfiles(item).some((profile) => profile.startsWith("synthetic"));
}

function isMeaningfulRecord(record, previousRecord) {
  if (record.kind != null) {
    return true;
  }
  if (Array.isArray(record.kinds) && record.kinds.length > 0) {
    return true;
  }
  if ((record.currentSeatId ?? null) !== (previousRecord?.currentSeatId ?? null)) {
    return true;
  }
  if (hasNonZeroAxes(record.xrAxes)) {
    return true;
  }
  if (hasRawInputActivity(record.xrRawInputs)) {
    return true;
  }
  return Boolean(record.interactionRay?.active);
}

function recordSignature(record) {
  return JSON.stringify({
    kind: record.kind ?? null,
    kinds: unique(record.kinds ?? []),
    currentSeatId: record.currentSeatId ?? null,
    xrAxes: {
      moveX: round(record.xrAxes?.moveX),
      moveY: round(record.xrAxes?.moveY),
      turnX: round(record.xrAxes?.turnX),
      turnY: round(record.xrAxes?.turnY)
    },
    interactionRay: {
      active: Boolean(record.interactionRay?.active),
      targetKind: record.interactionRay?.targetKind ?? null,
      seatId: record.interactionRay?.seatId ?? null,
      origin: record.interactionRay?.origin ? {
        x: round(record.interactionRay.origin.x),
        y: round(record.interactionRay.origin.y),
        z: round(record.interactionRay.origin.z)
      } : null,
      direction: record.interactionRay?.direction ? {
        x: round(record.interactionRay.direction.x),
        y: round(record.interactionRay.direction.y),
        z: round(record.interactionRay.direction.z)
      } : null
    },
    xrTurnCandidates: {
      mappedTurnX: round(record.xrTurnCandidates?.mappedTurnX),
      mappedTurnY: round(record.xrTurnCandidates?.mappedTurnY),
      rightPrimaryX: round(record.xrTurnCandidates?.rightPrimaryX),
      rightSecondaryX: round(record.xrTurnCandidates?.rightSecondaryX),
      playerYaw: round(record.xrTurnCandidates?.playerYaw)
    },
    xrRawInputs: (record.xrRawInputs ?? []).map((input) => ({
      handedness: input?.handedness ?? null,
      profiles: unique(input?.profiles ?? []),
      button0Pressed: Boolean(input?.button0Pressed),
      button1Pressed: Boolean(input?.button1Pressed),
      axes: (input?.axes ?? []).map((value) => round(value))
    }))
  });
}

function collapseMeaningfulHistory(history, historyLimit) {
  const collapsed = [];
  let previousRecord = null;
  let previousSignature = null;

  for (const record of history ?? []) {
    if (!isMeaningfulRecord(record, previousRecord)) {
      previousRecord = record;
      continue;
    }
    const signature = recordSignature(record);
    if (signature !== previousSignature) {
      collapsed.push(record);
      previousSignature = signature;
    }
    previousRecord = record;
  }

  return collapsed.slice(-historyLimit);
}

function formatRawInputs(inputs) {
  return (inputs ?? []).map((input) => {
    const handedness = input?.handedness ?? "unknown";
    const axes = (input?.axes ?? []).map((value) => formatNumber(value)).join(",");
    const buttons = [input?.button0Pressed ? "b0" : null, input?.button1Pressed ? "b1" : null].filter(Boolean).join(",") || "-";
    const profiles = unique(input?.profiles ?? []).join(",") || "-";
    return `${handedness}[${profiles}] axes=${axes || "-"} buttons=${buttons}`;
  }).join("; ") || "-";
}

function formatRecord(record) {
  const parts = [formatTimestamp(record.updatedAt)];
  const kinds = unique([record.kind, ...(record.kinds ?? [])]);
  if (kinds.length > 0) {
    parts.push(`kind=${kinds.join(",")}`);
  }
  if (record.currentSeatId) {
    parts.push(`seat=${record.currentSeatId}`);
  }
  if (record.xrTurnCandidates) {
    parts.push(`turn=(${formatNumber(record.xrTurnCandidates.mappedTurnX)}, ${formatNumber(record.xrTurnCandidates.mappedTurnY)})`);
    parts.push(`rawX=(${formatNumber(record.xrTurnCandidates.rightPrimaryX)}, ${formatNumber(record.xrTurnCandidates.rightSecondaryX)})`);
    parts.push(`yaw=${formatNumber(record.xrTurnCandidates.playerYaw)}`);
  } else if (record.xrAxes) {
    parts.push(`turn=(${formatNumber(record.xrAxes.turnX)}, ${formatNumber(record.xrAxes.turnY)})`);
  }
  if (record.interactionRay?.active || record.interactionRay?.targetKind === "seat") {
    const rayPart = `ray=${record.interactionRay?.targetKind ?? "active"}${record.interactionRay?.seatId ? `:${record.interactionRay.seatId}` : ""}`;
    parts.push(rayPart);
    if (record.interactionRay?.origin || record.interactionRay?.direction) {
      parts.push(`origin=${formatPoint(record.interactionRay?.origin)}`);
      parts.push(`dir=${formatPoint(record.interactionRay?.direction)}`);
    }
  }
  if (hasRawInputActivity(record.xrRawInputs)) {
    parts.push(`raw=${formatRawInputs(record.xrRawInputs)}`);
  }
  return parts.join(" | ");
}

function summarizeParticipant(item, historyLimit) {
  const history = collapseMeaningfulHistory(item.history ?? [], historyLimit);
  const header = [
    `participant=${item.participantId}`,
    `profile=${item.xrAvatarDebug?.profile ?? "-"}`,
    `rawProfiles=${rawProfiles(item).join(",") || "-"}`,
    `updatedAt=${item.updatedAt ?? "-"}`,
    `seat=${item.currentSeatId ?? "-"}`,
    `kind=${item.kind ?? "-"}`,
    `mappedTurn=(${formatNumber(item.xrTurnCandidates?.mappedTurnX)}, ${formatNumber(item.xrTurnCandidates?.mappedTurnY)})`,
    `rawTurnX=(${formatNumber(item.xrTurnCandidates?.rightPrimaryX)}, ${formatNumber(item.xrTurnCandidates?.rightSecondaryX)})`,
    `yaw=${formatNumber(item.xrTurnCandidates?.playerYaw)}`
  ].join(" | ");

  if (history.length === 0) {
    return `${header}\n  history: no meaningful XR rows after filtering`;
  }

  return `${header}\n${history.map((record) => `  ${formatRecord(record)}`).join("\n")}`;
}

function summarizePayload(items, allItems, options) {
  const summary = {
    baseUrl: options.baseUrl,
    roomId: options.roomId,
    participantCount: items.length,
    totalParticipantCount: allItems.length,
    syntheticParticipantCount: allItems.filter(isSyntheticParticipant).length,
    participants: items.map((item) => ({
      participantId: item.participantId,
      updatedAt: item.updatedAt ?? null,
      profile: item.xrAvatarDebug?.profile ?? null,
      rawProfiles: rawProfiles(item),
      currentSeatId: item.currentSeatId ?? null,
      kind: item.kind ?? null,
      kinds: unique(item.kinds ?? []),
      mappedTurnX: round(item.xrTurnCandidates?.mappedTurnX),
      mappedTurnY: round(item.xrTurnCandidates?.mappedTurnY),
      rightPrimaryX: round(item.xrTurnCandidates?.rightPrimaryX),
      rightSecondaryX: round(item.xrTurnCandidates?.rightSecondaryX),
      playerYaw: round(item.xrTurnCandidates?.playerYaw),
      meaningfulHistory: collapseMeaningfulHistory(item.history ?? [], options.historyLimit)
    }))
  };
  if (options.json) {
    return JSON.stringify(summary, null, 2);
  }
  const lines = [
    `room=${summary.roomId} | shown=${summary.participantCount} | total=${summary.totalParticipantCount} | syntheticFiltered=${summary.syntheticParticipantCount}${options.participantId ? ` | participant=${options.participantId}` : ""}`
  ];
  if (items.length === 0) {
    lines.push("No matching participants.");
  }
  for (const item of items) {
    lines.push(summarizeParticipant(item, options.historyLimit));
  }
  return `${lines.join("\n\n")}\n`;
}

async function fetchTelemetry(options) {
  const url = new URL(`/api/rooms/${options.roomId}/xr-telemetry`, options.baseUrl);
  const response = await fetch(url, {
    headers: {
      "x-noah-admin-token": options.adminToken
    }
  });
  if (!response.ok) {
    throw new Error(`telemetry_http_${response.status}`);
  }
  const payload = await response.json();
  const allItems = Array.isArray(payload.items) ? payload.items : [];
  const filtered = allItems
    .filter((item) => options.includeSynthetic || !isSyntheticParticipant(item))
    .filter((item) => !options.participantId || item.participantId === options.participantId)
    .sort((left, right) => {
      const leftTime = Date.parse(left.updatedAt ?? "");
      const rightTime = Date.parse(right.updatedAt ?? "");
      return rightTime - leftTime;
    });
  return { allItems, items: filtered };
}

function fingerprint(items) {
  return JSON.stringify(items.map((item) => ({
    participantId: item.participantId,
    updatedAt: item.updatedAt ?? null,
    kind: item.kind ?? null,
    currentSeatId: item.currentSeatId ?? null,
    playerYaw: round(item.xrTurnCandidates?.playerYaw),
    historyTail: collapseMeaningfulHistory(item.history ?? [], 4).map((record) => recordSignature(record))
  })));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  let lastFingerprint = null;
  const deadline = options.timeoutMs === 0 ? Number.POSITIVE_INFINITY : Date.now() + options.timeoutMs;
  let iteration = 0;

  while (Date.now() <= deadline) {
    iteration += 1;
    const { allItems, items } = await fetchTelemetry(options);
    const nextFingerprint = fingerprint(items);
    const shouldPrint = !options.watch || iteration === 1 || nextFingerprint !== lastFingerprint;
    if (shouldPrint) {
      if (options.watch && !options.json) {
        process.stdout.write(`\n=== ${new Date().toISOString()} ===\n`);
      }
      process.stdout.write(summarizePayload(items, allItems, options));
      lastFingerprint = nextFingerprint;
    }
    if (!options.watch) {
      return;
    }
    if (options.waitReal && items.length > 0) {
      return;
    }
    await sleep(options.intervalMs);
  }

  if (options.waitReal) {
    process.exitCode = 1;
    process.stderr.write(`wait_real_timeout room=${options.roomId} timeoutMs=${options.timeoutMs}\n`);
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
