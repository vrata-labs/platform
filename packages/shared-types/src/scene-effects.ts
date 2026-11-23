/** Optional, data-only bindings to animation clips inside the same scene GLB. */
export interface SceneClipEffect {
  id: string;
  kind: "clip-loop";
  root: string;
  clips: string[];
  audio?: SceneEffectAudio;
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

export function isSceneClipEffects(value: unknown): value is SceneClipEffect[] {
  if (!Array.isArray(value) || value.length > 16) return false;
  const ids = new Set<string>(),
    roots = new Set<string>(),
    clips = new Set<string>();
  const audio = new Map<SceneAudioPath, string>();
  let soundCount = 0;
  return value.every((item) => {
    if (
      !item ||
      typeof item !== "object" ||
      Object.keys(item).some((k) => !["id", "kind", "root", "clips", "audio"].includes(k)) ||
      !name(item.id) ||
      !name(item.root) ||
      item.kind !== "clip-loop" ||
      ids.has(item.id) ||
      roots.has(item.root) ||
      !Array.isArray(item.clips) ||
      item.clips.length < 1 ||
      item.clips.length > 4
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
    return item.clips.every((clip: unknown) => {
      if (!name(clip) || clips.has(clip)) return false;
      clips.add(clip);
      return true;
    });
  });
}
