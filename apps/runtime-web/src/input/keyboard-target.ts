const textTargets = "dialog, #guest-onboarding, textarea, select, input:not([type='button']):not([type='submit']):not([type='reset']):not([type='checkbox']):not([type='radio']), [contenteditable]:not([contenteditable='false'])";
const controlTargets = ".hud, button, a, summary, input[type='button'], input[type='submit'], input[type='reset'], input[type='checkbox'], input[type='radio']";
const movementKeys = new Set(["KeyW", "KeyA", "KeyS", "KeyD", "ShiftLeft", "ShiftRight"]);

function closest(target: EventTarget | null, selector: string): boolean {
  const element = target as (EventTarget & { closest?: (selector: string) => Element | null }) | null;
  return typeof element?.closest === "function" && Boolean(element.closest(selector));
}

/** Fields consume all keys; ordinary controls retain WASD/Shift movement while
 * native navigation keys stay in the UI. Neither forwards to a stale media focus. */
export function isRuntimeUiKeyboardTarget(target: EventTarget | null): boolean {
  return closest(target, textTargets) || closest(target, controlTargets);
}

export function clearRuntimeKeyboardState(keys: Record<string, boolean>): void {
  for (const code of Object.keys(keys)) keys[code] = false;
}

export function collectRuntimeKeyboardSample(keys: Record<string, boolean>, event: { code: string; target: EventTarget | null }, pressed: boolean): boolean {
  if (closest(event.target, textTargets)) { clearRuntimeKeyboardState(keys); return false; }
  if (closest(event.target, controlTargets)) {
    if (event.code) keys[event.code] = movementKeys.has(event.code) && pressed;
    return false;
  }
  if (event.code) keys[event.code] = pressed;
  return true;
}
