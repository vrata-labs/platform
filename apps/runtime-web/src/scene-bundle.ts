export interface SceneBundleSpawnPoint {
  id: string;
  position: {
    x: number;
    y: number;
    z: number;
  };
  yaw?: number;
}

export type SceneBundleRenderProfile = "neutral-pbr" | "baked-pbr-v1";

export interface SceneBundleSeatAnchor {
  id: string;
  position: {
    x: number;
    y: number;
    z: number;
  };
  yaw: number;
  seatHeight: number;
  radius: number;
  label?: string;
}

export interface SceneBundleMediaSurface {
  manifestFormat: "f3" | "legacy";
  surfaceId: string;
  representation: "platform-runtime-plane";
  position: {
    x: number;
    y: number;
    z: number;
  };
  yaw: number;
  pitch: number;
  roll: number;
  widthM: number;
  heightM: number;
  pixelDimensions: {
    width?: number;
    height?: number;
  };
  frontFace: "local-positive-z";
  input: {
    enabled: boolean;
    maxDistanceM: number;
  };
  visible: boolean;
  label?: string;
  kind?: "wall" | "table" | "laptop" | "floating" | "custom";
  legacyAllowedObjectTypes?: string[];
}

export const MEDIA_SURFACE_MAX_PIXEL_SIDE = 8192;
export const MEDIA_SURFACE_MAX_TOTAL_PIXELS = 33_554_432;
export const LEGACY_MEDIA_SURFACE_NEAR_CONTACT_DISTANCE_M = 0.06;

export interface SceneBundleAttribution {
  title: string;
  author: string;
  source: string;
  license: string;
  authorUrl?: string;
  licenseUrl?: string;
  changes?: string;
}

export interface SceneBundleManifest {
  schemaVersion: 1;
  sceneId: string;
  label: string;
  source: string;
  glbPath: string;
  renderMode?: "default" | "clean";
  renderProfile?: SceneBundleRenderProfile;
  spawnPoints: SceneBundleSpawnPoint[];
  anchors?: {
    teleportFloorY?: number;
    seatAnchors: SceneBundleSeatAnchor[];
  };
  mediaSurfaces?: SceneBundleMediaSurface[];
  materialOverrides?: Array<{
    match: string;
    mapPath?: string;
    color?: {
      r: number;
      g: number;
      b: number;
    };
  }>;
  bounds?: {
    width: number;
    height: number;
    depth: number;
  };
  preview?: string;
  attributions?: SceneBundleAttribution[];
  notes?: string;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function assertObject(value: unknown, errorCode: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(errorCode);
  }
  return value as Record<string, unknown>;
}

function assertString(value: unknown, errorCode: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(errorCode);
  }
  return value;
}

function assertHttpUrl(value: unknown, errorCode: string): string {
  const url = assertString(value, errorCode);
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(errorCode);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(errorCode);
  }
  return url;
}

function parseSpawnPoint(input: unknown, index: number): SceneBundleSpawnPoint {
  const payload = assertObject(input, `invalid_scene_bundle_spawn_point:${index}`);
  const position = assertObject(payload.position, `invalid_scene_bundle_spawn_position:${index}`);
  if (!isFiniteNumber(position.x) || !isFiniteNumber(position.y) || !isFiniteNumber(position.z)) {
    throw new Error(`invalid_scene_bundle_spawn_position:${index}`);
  }
  if (payload.yaw !== undefined && !isFiniteNumber(payload.yaw)) {
    throw new Error(`invalid_scene_bundle_spawn_yaw:${index}`);
  }

  return {
    id: assertString(payload.id, `invalid_scene_bundle_spawn_id:${index}`),
    position: {
      x: position.x,
      y: position.y,
      z: position.z
    },
    yaw: payload.yaw
  };
}

function parseSeatAnchor(input: unknown, index: number): SceneBundleSeatAnchor {
  const payload = assertObject(input, `invalid_scene_bundle_seat_anchor:${index}`);
  const position = assertObject(payload.position, `invalid_scene_bundle_seat_anchor_position:${index}`);
  if (!isFiniteNumber(position.x) || !isFiniteNumber(position.y) || !isFiniteNumber(position.z)) {
    throw new Error(`invalid_scene_bundle_seat_anchor_position:${index}`);
  }
  if (!isFiniteNumber(payload.yaw)) {
    throw new Error(`invalid_scene_bundle_seat_anchor_yaw:${index}`);
  }
  if (!isFiniteNumber(payload.seatHeight)) {
    throw new Error(`invalid_scene_bundle_seat_anchor_height:${index}`);
  }
  const radius = payload.radius === undefined
    ? 0.4
    : isFiniteNumber(payload.radius)
      ? payload.radius
      : Number.NaN;
  if (!Number.isFinite(radius) || radius <= 0) {
    throw new Error(`invalid_scene_bundle_seat_anchor_radius:${index}`);
  }

  return {
    id: assertString(payload.id, `invalid_scene_bundle_seat_anchor_id:${index}`),
    position: {
      x: position.x,
      y: position.y,
      z: position.z
    },
    yaw: payload.yaw,
    seatHeight: payload.seatHeight,
    radius,
    label: payload.label === undefined ? undefined : assertString(payload.label, `invalid_scene_bundle_seat_anchor_label:${index}`)
  };
}

function parsePositiveNumber(value: unknown, errorCode: string): number {
  if (!isFiniteNumber(value) || value <= 0) {
    throw new Error(errorCode);
  }
  return value;
}

function parseOptionalBoolean(value: unknown, errorCode: string): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "boolean") {
    throw new Error(errorCode);
  }
  return value;
}

function parsePixelDimension(value: unknown, errorCode: string): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0 || Number(value) > MEDIA_SURFACE_MAX_PIXEL_SIDE) {
    throw new Error(errorCode);
  }
  return value as number;
}

function assertPixelBudget(width: number | undefined, height: number | undefined, errorCode: string): void {
  if (width !== undefined && height !== undefined && width * height > MEDIA_SURFACE_MAX_TOTAL_PIXELS) {
    throw new Error(errorCode);
  }
}

function parseF3MediaSurface(payload: Record<string, unknown>, index: number): SceneBundleMediaSurface {
  if (payload.representation !== "platform-runtime-plane") {
    throw new Error(`invalid_scene_bundle_media_surface_representation:${index}`);
  }
  const position = assertObject(payload.position, `invalid_scene_bundle_media_surface_position:${index}`);
  if (!isFiniteNumber(position.x) || !isFiniteNumber(position.y) || !isFiniteNumber(position.z)) {
    throw new Error(`invalid_scene_bundle_media_surface_position:${index}`);
  }
  if (!isFiniteNumber(payload.yaw)) {
    throw new Error(`invalid_scene_bundle_media_surface_yaw:${index}`);
  }
  const pixelDimensions = assertObject(payload.pixelDimensions, `invalid_scene_bundle_media_surface_pixel_dimensions:${index}`);
  const widthPx = parsePixelDimension(pixelDimensions.width, `invalid_scene_bundle_media_surface_pixel_dimensions:${index}`);
  const heightPx = parsePixelDimension(pixelDimensions.height, `invalid_scene_bundle_media_surface_pixel_dimensions:${index}`);
  assertPixelBudget(widthPx, heightPx, `invalid_scene_bundle_media_surface_pixel_dimensions:${index}`);
  if (payload.frontFace !== "local-positive-z") {
    throw new Error(`invalid_scene_bundle_media_surface_front_face:${index}`);
  }
  const surfaceInput = assertObject(payload.input, `invalid_scene_bundle_media_surface_input:${index}`);
  if (typeof surfaceInput.enabled !== "boolean") {
    throw new Error(`invalid_scene_bundle_media_surface_input_enabled:${index}`);
  }
  if (!isFiniteNumber(surfaceInput.maxDistanceM) || surfaceInput.maxDistanceM <= 0) {
    throw new Error(`invalid_scene_bundle_media_surface_input_max_distance_m:${index}`);
  }

  return {
    manifestFormat: "f3",
    surfaceId: assertString(payload.surfaceId, `invalid_scene_bundle_media_surface_id:${index}`),
    representation: "platform-runtime-plane",
    position: {
      x: position.x,
      y: position.y,
      z: position.z
    },
    yaw: payload.yaw,
    pitch: 0,
    roll: 0,
    widthM: parsePositiveNumber(payload.widthM, `invalid_scene_bundle_media_surface_width_m:${index}`),
    heightM: parsePositiveNumber(payload.heightM, `invalid_scene_bundle_media_surface_height_m:${index}`),
    pixelDimensions: {
      width: widthPx,
      height: heightPx
    },
    frontFace: "local-positive-z",
    input: {
      enabled: surfaceInput.enabled,
      maxDistanceM: surfaceInput.maxDistanceM
    },
    visible: true
  };
}

function parseLegacyMediaSurface(payload: Record<string, unknown>, index: number): SceneBundleMediaSurface {
  const transform = assertObject(payload.transform, `invalid_scene_bundle_media_surface_transform:${index}`);
  if (!isFiniteNumber(transform.x) || !isFiniteNumber(transform.y) || !isFiniteNumber(transform.z)) {
    throw new Error(`invalid_scene_bundle_media_surface_transform:${index}`);
  }
  const yaw = transform.yaw === undefined ? 0 : transform.yaw;
  const pitch = transform.pitch === undefined ? 0 : transform.pitch;
  const roll = transform.roll === undefined ? 0 : transform.roll;
  if (!isFiniteNumber(yaw)) throw new Error(`invalid_scene_bundle_media_surface_yaw:${index}`);
  if (!isFiniteNumber(pitch)) throw new Error(`invalid_scene_bundle_media_surface_pitch:${index}`);
  if (!isFiniteNumber(roll)) throw new Error(`invalid_scene_bundle_media_surface_roll:${index}`);

  const widthPx = payload.widthPx === undefined
    ? undefined
    : parsePixelDimension(payload.widthPx, `invalid_scene_bundle_media_surface_width_px:${index}`);
  const heightPx = payload.heightPx === undefined
    ? undefined
    : parsePixelDimension(payload.heightPx, `invalid_scene_bundle_media_surface_height_px:${index}`);
  assertPixelBudget(widthPx, heightPx, `invalid_scene_bundle_media_surface_pixel_dimensions:${index}`);

  const parsed: SceneBundleMediaSurface = {
    manifestFormat: "legacy",
    surfaceId: assertString(payload.surfaceId, `invalid_scene_bundle_media_surface_id:${index}`),
    representation: "platform-runtime-plane",
    position: { x: transform.x, y: transform.y, z: transform.z },
    yaw,
    pitch,
    roll,
    widthM: parsePositiveNumber(payload.widthM, `invalid_scene_bundle_media_surface_width_m:${index}`),
    heightM: parsePositiveNumber(payload.heightM, `invalid_scene_bundle_media_surface_height_m:${index}`),
    pixelDimensions: { width: widthPx, height: heightPx },
    frontFace: "local-positive-z",
    input: { enabled: true, maxDistanceM: LEGACY_MEDIA_SURFACE_NEAR_CONTACT_DISTANCE_M },
    visible: parseOptionalBoolean(payload.visible, `invalid_scene_bundle_media_surface_visible:${index}`) ?? true
  };

  if (payload.label !== undefined) {
    parsed.label = assertString(payload.label, `invalid_scene_bundle_media_surface_label:${index}`);
  }
  if (payload.kind !== undefined) {
    if (payload.kind !== "wall" && payload.kind !== "table" && payload.kind !== "laptop" && payload.kind !== "floating" && payload.kind !== "custom") {
      throw new Error(`invalid_scene_bundle_media_surface_kind:${index}`);
    }
    parsed.kind = payload.kind;
  }
  if (payload.allowedObjectTypes !== undefined) {
    if (!Array.isArray(payload.allowedObjectTypes)) {
      throw new Error(`invalid_scene_bundle_media_surface_allowed_object_types:${index}`);
    }
    parsed.legacyAllowedObjectTypes = payload.allowedObjectTypes.map((entry, typeIndex) => (
      assertString(entry, `invalid_scene_bundle_media_surface_allowed_object_type:${index}:${typeIndex}`)
    ));
  }
  return parsed;
}

function parseMediaSurface(input: unknown, index: number): SceneBundleMediaSurface {
  const payload = assertObject(input, `invalid_scene_bundle_media_surface:${index}`);
  const isF3 = payload.representation !== undefined
    || payload.position !== undefined
    || payload.pixelDimensions !== undefined
    || payload.frontFace !== undefined
    || payload.input !== undefined;
  return isF3 ? parseF3MediaSurface(payload, index) : parseLegacyMediaSurface(payload, index);
}

function parseAttribution(input: unknown, index: number): SceneBundleAttribution {
  const payload = assertObject(input, `invalid_scene_bundle_attribution:${index}`);
  const parsed: SceneBundleAttribution = {
    title: assertString(payload.title, `invalid_scene_bundle_attribution_title:${index}`),
    author: assertString(payload.author, `invalid_scene_bundle_attribution_author:${index}`),
    source: assertHttpUrl(payload.source, `invalid_scene_bundle_attribution_source:${index}`),
    license: assertString(payload.license, `invalid_scene_bundle_attribution_license:${index}`)
  };

  if (payload.authorUrl !== undefined) {
    parsed.authorUrl = assertHttpUrl(payload.authorUrl, `invalid_scene_bundle_attribution_author_url:${index}`);
  }
  if (payload.licenseUrl !== undefined) {
    parsed.licenseUrl = assertHttpUrl(payload.licenseUrl, `invalid_scene_bundle_attribution_license_url:${index}`);
  }
  if (payload.changes !== undefined) {
    parsed.changes = assertString(payload.changes, `invalid_scene_bundle_attribution_changes:${index}`);
  }

  return parsed;
}

export function parseSceneBundleManifest(input: unknown): SceneBundleManifest {
  const payload = assertObject(input, "invalid_scene_bundle_manifest");
  if (payload.schemaVersion !== 1) {
    throw new Error(`unsupported_scene_bundle_schema:${String(payload.schemaVersion ?? "unknown")}`);
  }

  const spawnPointsRaw = payload.spawnPoints;
  if (!Array.isArray(spawnPointsRaw)) {
    throw new Error("invalid_scene_bundle_spawn_points");
  }

  const manifest: SceneBundleManifest = {
    schemaVersion: 1,
    sceneId: assertString(payload.sceneId, "invalid_scene_bundle_scene_id"),
    label: assertString(payload.label, "invalid_scene_bundle_label"),
    source: assertString(payload.source, "invalid_scene_bundle_source"),
    glbPath: assertString(payload.glbPath, "invalid_scene_bundle_glb_path"),
    spawnPoints: spawnPointsRaw.map((entry, index) => parseSpawnPoint(entry, index))
  };

  if (payload.renderMode !== undefined) {
    if (payload.renderMode !== "default" && payload.renderMode !== "clean") {
      throw new Error("invalid_scene_bundle_render_mode");
    }
    manifest.renderMode = payload.renderMode;
  }
  if (payload.renderProfile !== undefined) {
    if (payload.renderProfile !== "neutral-pbr" && payload.renderProfile !== "baked-pbr-v1") {
      throw new Error("invalid_scene_bundle_render_profile");
    }
    manifest.renderProfile = payload.renderProfile;
  }

  if (payload.anchors !== undefined) {
    const anchors = assertObject(payload.anchors, "invalid_scene_bundle_anchors");
    const seatAnchorsRaw = anchors.seatAnchors;
    if (seatAnchorsRaw !== undefined && !Array.isArray(seatAnchorsRaw)) {
      throw new Error("invalid_scene_bundle_seat_anchors");
    }
    const parsedAnchors: NonNullable<SceneBundleManifest["anchors"]> = {
      seatAnchors: Array.isArray(seatAnchorsRaw) ? seatAnchorsRaw.map((entry, index) => parseSeatAnchor(entry, index)) : []
    };
    if (anchors.teleportFloorY !== undefined) {
      if (!isFiniteNumber(anchors.teleportFloorY)) {
        throw new Error("invalid_scene_bundle_teleport_floor_y");
      }
      parsedAnchors.teleportFloorY = anchors.teleportFloorY;
    }
    manifest.anchors = parsedAnchors;
  }

  if (payload.mediaSurfaces !== undefined) {
    if (!Array.isArray(payload.mediaSurfaces)) {
      throw new Error("invalid_scene_bundle_media_surfaces");
    }
    if (payload.mediaSurfaces.length === 0) {
      throw new Error("invalid_scene_bundle_media_surfaces_empty");
    }
    const mediaSurfaces = payload.mediaSurfaces.map((entry, index) => parseMediaSurface(entry, index));
    const surfaceIds = new Set<string>();
    for (let index = 0; index < mediaSurfaces.length; index += 1) {
      const surfaceId = mediaSurfaces[index]!.surfaceId;
      if (surfaceIds.has(surfaceId)) {
        throw new Error(`duplicate_scene_bundle_media_surface_id:${index}`);
      }
      surfaceIds.add(surfaceId);
    }
    const manifestFormats = new Set(mediaSurfaces.map((surface) => surface.manifestFormat));
    if (manifestFormats.size > 1) {
      throw new Error("invalid_scene_bundle_media_surfaces_mixed_formats");
    }
    if (manifestFormats.has("f3")) {
      const debugMainCount = mediaSurfaces.filter((surface) => surface.surfaceId === "debug-main").length;
      if (debugMainCount !== 1) {
        throw new Error(`invalid_scene_bundle_media_surfaces_debug_main_count:${debugMainCount}`);
      }
    }
    manifest.mediaSurfaces = mediaSurfaces;
  }

  if (payload.bounds !== undefined) {
    const bounds = assertObject(payload.bounds, "invalid_scene_bundle_bounds");
    if (!isFiniteNumber(bounds.width) || !isFiniteNumber(bounds.height) || !isFiniteNumber(bounds.depth)) {
      throw new Error("invalid_scene_bundle_bounds");
    }
    manifest.bounds = {
      width: bounds.width,
      height: bounds.height,
      depth: bounds.depth
    };
  }

  if (payload.materialOverrides !== undefined) {
    if (!Array.isArray(payload.materialOverrides)) {
      throw new Error("invalid_scene_bundle_material_overrides");
    }
    manifest.materialOverrides = payload.materialOverrides.map((entry, index) => {
      const override = assertObject(entry, `invalid_scene_bundle_material_override:${index}`);
      const parsed: NonNullable<SceneBundleManifest["materialOverrides"]>[number] = {
        match: assertString(override.match, `invalid_scene_bundle_material_override_match:${index}`)
      };
      if (override.mapPath !== undefined) {
        parsed.mapPath = assertString(override.mapPath, `invalid_scene_bundle_material_override_map:${index}`);
      }
      if (override.color !== undefined) {
        const color = assertObject(override.color, `invalid_scene_bundle_material_override_color:${index}`);
        if (!isFiniteNumber(color.r) || !isFiniteNumber(color.g) || !isFiniteNumber(color.b)) {
          throw new Error(`invalid_scene_bundle_material_override_color:${index}`);
        }
        parsed.color = {
          r: color.r,
          g: color.g,
          b: color.b
        };
      }
      return parsed;
    });
  }

  if (payload.preview !== undefined) {
    manifest.preview = assertString(payload.preview, "invalid_scene_bundle_preview");
  }
  if (payload.attributions !== undefined) {
    if (!Array.isArray(payload.attributions)) {
      throw new Error("invalid_scene_bundle_attributions");
    }
    manifest.attributions = payload.attributions.map((entry, index) => parseAttribution(entry, index));
  }
  if (payload.notes !== undefined) {
    manifest.notes = assertString(payload.notes, "invalid_scene_bundle_notes");
  }

  return manifest;
}

export function resolveSceneAssetUrl(bundleUrl: string, assetPath: string): string {
  return new URL(assetPath, bundleUrl).toString();
}

export function pickSceneSpawnPoint(manifest: SceneBundleManifest): SceneBundleSpawnPoint | null {
  return manifest.spawnPoints[0] ?? null;
}
