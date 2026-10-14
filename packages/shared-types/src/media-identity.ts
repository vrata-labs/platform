/** A media address fixes a source ceiling, not the current role or a JWT lifetime. */
export type UserMediaScope = "m" | "s" | "ms";
export interface UserMediaBinding {
  readonly participantId: string;
  readonly scope: UserMediaScope;
}
export interface UserMediaIdentity {
  readonly identity: string;
  readonly attributes: Readonly<{ vrataMediaBinding: string }>;
}

const validParticipant = (value: unknown): value is string => typeof value === "string" && value.length > 0
  && value.length <= 200 && !/[\u0000-\u001f]/.test(value);
const scopes: readonly UserMediaScope[] = ["m", "s", "ms"];
const address = /^vmi2\.(m|s|ms)\.[a-f0-9]{64}$/;

export function userMediaScope(sources: readonly string[]): UserMediaScope | null {
  const value = sources.join(",");
  return value === "microphone" ? "m" : value === "screen_share,screen_share_audio" ? "s"
    : value === "microphone,screen_share,screen_share_audio" ? "ms" : null;
}

function serialize(binding: UserMediaBinding): string {
  return JSON.stringify({ v: 2, participantId: binding.participantId, scope: binding.scope });
}

/** JSON preserves recovered IDs, including UTF-16 escapes, across Go/JS string transport. */
export function parseUserMediaBinding(identity: string, attributes: Readonly<Record<string, string>>): UserMediaBinding | null {
  const match = address.exec(identity);
  const value = attributes.vrataMediaBinding;
  if (!match || typeof value !== "string" || value.length > 4096
    || Object.keys(attributes).some(key => key.startsWith("vrata") && key !== "vrataMediaBinding")) return null;
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    if (!parsed || parsed.v !== 2 || !validParticipant(parsed.participantId) || parsed.scope !== match[1]) return null;
    const binding = Object.freeze({ participantId: parsed.participantId, scope: parsed.scope as UserMediaScope });
    return serialize(binding) === value ? binding : null;
  } catch { return null; }
}

export async function createUserMediaIdentity(room: string, binding: UserMediaBinding): Promise<UserMediaIdentity> {
  if (typeof room !== "string" || room.length === 0 || room.length > 1024 || !validParticipant(binding.participantId)
    || !scopes.includes(binding.scope)) throw new Error("invalid_user_media_binding");
  const serialized = serialize(binding);
  const input = new TextEncoder().encode(JSON.stringify(["vrata.media-identity.v2", room, serialized]));
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", input));
  const hex = Array.from(hash, byte => byte.toString(16).padStart(2, "0")).join("");
  return Object.freeze({ identity: `vmi2.${binding.scope}.${hex}`, attributes: Object.freeze({ vrataMediaBinding: serialized }) });
}

/** The room comes from the authenticated LiveKit connection, never from a participant attribute. */
export async function verifyUserMediaIdentity(room: string, identity: string, attributes: Readonly<Record<string, string>>): Promise<UserMediaBinding | null> {
  const binding = parseUserMediaBinding(identity, attributes);
  if (!binding) return null;
  try { return (await createUserMediaIdentity(room, binding)).identity === identity ? binding : null; }
  catch { return null; }
}
