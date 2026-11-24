/** Optional, data-only bindings to assets inside the same scene GLB. */
export interface SceneClipEffect {
  id: string;
  kind: "clip-loop";
  root: string;
  clips: string[];
  audio?: SceneEffectAudio;
}

export interface SceneSpriteEffect {
  id: string;
  kind: "sprite-loop";
  root: string;
  atlas: { columns: number; rows: number; cycleSeconds: number };
  switch: { mount: string; handle: string; offQuaternion: [number, number, number, number]; initiallyOn: boolean };
  audio?: SceneEffectAudio;
}

/** The handle is the only movable part. All named nodes refer to the same approved GLB. */
export interface SceneHeldPropEffect {
  id: string;
  kind: "held-prop";
  root: string;
  fixture: string;
  handle: string;
  tip: string;
  connector: string;
  tether: string;
  restHose: string;
  soundSource: string;
  pickupM: number;
  reachM: number;
  contactM: number;
  hoseRadiusM: number;
  burst: { columns: number; rows: number; durationSeconds: number; intervalSeconds: number };
  audio?: SceneEffectAudio;
}

export type SceneEffect = SceneClipEffect | SceneSpriteEffect | SceneHeldPropEffect;
export interface SceneEffectSwitchState {
  versionId: string;
  switches: { id: string; enabled: boolean }[];
}

export type SceneAudioPath = `audio/${string}.wav`;
export interface SceneEffectAudio {
  path: SceneAudioPath;
  sha256: string;
  gain: number;
  nearM: number;
  farM: number;
}

export const SCENE_AUDIO_MAX_BYTES = 44 + 48_000 * 2 * 16;
export const isSceneAudioPath = (value: unknown): value is SceneAudioPath =>
  typeof value === "string" && /^audio\/[a-z0-9]+(?:-[a-z0-9]+)*\.wav$/.test(value) && value.length <= 74;

/** The transfer format is exactly a canonical mono 16-bit PCM WAV, not arbitrary media or metadata. */
export function isSceneAudioWav(bytes: Uint8Array): boolean {
  if (bytes.length <= 44 || bytes.length > SCENE_AUDIO_MAX_BYTES || bytes.length % 2 !== 0) return false;
  const d = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const rate = d.getUint32(24, true);
  return d.getUint32(0) === 0x52494646 && d.getUint32(4, true) === bytes.length - 8 &&
    d.getUint32(8) === 0x57415645 && d.getUint32(12) === 0x666d7420 && d.getUint32(16, true) === 16 &&
    d.getUint16(20, true) === 1 && d.getUint16(22, true) === 1 && rate >= 16_000 && rate <= 48_000 &&
    d.getUint32(28, true) === rate * 2 && d.getUint16(32, true) === 2 && d.getUint16(34, true) === 16 &&
    d.getUint32(36) === 0x64617461 && d.getUint32(40, true) === bytes.length - 44 && bytes.length - 44 <= rate * 2 * 16;
}

function isSceneEffectAudio(value: unknown): value is SceneEffectAudio {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  const positive = (n: unknown, max: number): n is number => typeof n === "number" && Number.isFinite(n) && n > 0 && n <= max;
  return Object.keys(v).length === 5 && isSceneAudioPath(v.path) && typeof v.sha256 === "string" && /^[0-9a-f]{64}$/.test(v.sha256) &&
    positive(v.gain, 0.25) && positive(v.nearM, 100) && positive(v.farM, 250) && v.nearM < v.farM;
}

const name = (value: unknown): value is string =>
  typeof value === "string" && /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(value);

const atlasSize = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n) && n >= 1 && n <= 16;
const inRange = (n: unknown, min: number, max: number) => typeof n === "number" && n >= min && n <= max;

export function isSceneEffectSwitchState(value: unknown): value is SceneEffectSwitchState {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as SceneEffectSwitchState;
  const ids = new Set<string>();
  return typeof v.versionId === "string" && /^[a-z0-9-]{1,64}$/.test(v.versionId) &&
    Array.isArray(v.switches) && v.switches.length <= 16 && v.switches.every(s => {
      if (!s || !name(s.id) || typeof s.enabled !== "boolean" || ids.has(s.id)) return false;
      ids.add(s.id);
      return true;
    });
}

export function isSceneEffects(value: unknown): value is SceneEffect[] {
  if (!Array.isArray(value) || value.length > 16) return false;
  const ids = new Set<string>(),
    roots = new Set<string>(),
    clips = new Set<string>(),
    switches = new Set<string>();
  const audio = new Map<SceneAudioPath, string>();
  let soundCount = 0;
  let heldPropCount = 0;
  return value.every((item) => {
    if (
      !item ||
      typeof item !== "object" ||
      !name(item.id) ||
      !name(item.root) ||
      ids.has(item.id) ||
      roots.has(item.root)
    )
      return false;
    if (item.audio !== undefined) {
      if (++soundCount > 4 || !isSceneEffectAudio(item.audio)) return false;
      const hash = audio.get(item.audio.path);
      if (hash !== undefined && hash !== item.audio.sha256) return false;
      audio.set(item.audio.path, item.audio.sha256);
    }
    ids.add(item.id);
    roots.add(item.root);
    if (item.kind === "held-prop") {
      if (++heldPropCount > 1) return false;
      const nodes = ["fixture", "handle", "tip", "connector", "tether", "restHose", "soundSource"];
      if (Object.keys(item).some(k => !["id", "kind", "root", ...nodes, "pickupM", "reachM", "contactM", "hoseRadiusM", "burst", "audio"].includes(k))) return false;
      const { burst } = item;
      if (nodes.some(key => !name(item[key]) || switches.has(item[key])) || new Set(nodes.map(key => item[key])).size !== nodes.length ||
          !inRange(item.pickupM, .05, .5) || !inRange(item.reachM, .5, 3) ||
          !inRange(item.contactM, .05, .25) || !inRange(item.hoseRadiusM, .002, .03) ||
          !burst || Object.keys(burst).length !== 4 || !atlasSize(burst.columns) || !atlasSize(burst.rows) ||
          !inRange(burst.durationSeconds, .3, 6) || !inRange(burst.intervalSeconds, burst.durationSeconds, 20)) return false;
      for (const key of nodes) switches.add(item[key]);
      return true;
    }
    if (item.kind === "sprite-loop") {
      if (Object.keys(item).some(k => !["id", "kind", "root", "atlas", "switch", "audio"].includes(k))) return false;
      const { atlas, switch: control } = item;
      if (!atlas || Object.keys(atlas).length !== 3 || !atlasSize(atlas.columns) || !atlasSize(atlas.rows) ||
          typeof atlas.cycleSeconds !== "number" || !(atlas.cycleSeconds >= 0.25 && atlas.cycleSeconds <= 16) ||
          !control || Object.keys(control).length !== 4 || !name(control.mount) || !name(control.handle) ||
          control.mount === control.handle || switches.has(control.mount) || switches.has(control.handle) ||
          typeof control.initiallyOn !== "boolean" || !Array.isArray(control.offQuaternion) || control.offQuaternion.length !== 4 ||
          !control.offQuaternion.every((n: unknown) => typeof n === "number" && Number.isFinite(n)) ||
          Math.abs(Math.hypot(...control.offQuaternion) - 1) > 0.001) return false;
      switches.add(control.mount);
      switches.add(control.handle);
      return true;
    }
    if (item.kind !== "clip-loop" || Object.keys(item).some(k => !["id", "kind", "root", "clips", "audio"].includes(k)) ||
        !Array.isArray(item.clips) || item.clips.length < 1 || item.clips.length > 4) return false;
    return item.clips.every((clip: unknown) => {
      if (!name(clip) || clips.has(clip)) return false;
      clips.add(clip);
      return true;
    });
  }) && [...switches].every(node => !roots.has(node));
}
