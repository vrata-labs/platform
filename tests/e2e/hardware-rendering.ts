// Scenarios whose deadlines assume a GPU (several RAF per second in actual rooms)
// detect the browser's WebGL renderer before their main part. Only a positively
// identified software rasterizer is skipped; the scenario itself is unchanged.
export const REQUIRE_HARDWARE_RENDERING_ENV = "VRATA_E2E_REQUIRE_HARDWARE_RENDERING";

export const SOFTWARE_RENDERER_PATTERN =
  /swiftshader|llvmpipe|lavapipe|softpipe|software rasterizer|software renderer|basic render driver|gdi generic/i;

export interface WebglRendererInfo {
  api: "webgl2" | "webgl" | null;
  renderer: string | null;
  vendor: string | null;
}

export interface HardwareRenderingDecision {
  action: "run" | "skip" | "fail";
  reason: string | null;
}

// Runs in the page (page.evaluate): a throwaway canvas in the same browser and GPU
// process as the scene; the context is released before the page navigates.
export function readWebglRenderer(): WebglRendererInfo {
  const canvas = document.createElement("canvas");
  for (const api of ["webgl2", "webgl"] as const) {
    const gl = canvas.getContext(api) as WebGLRenderingContext | null;
    if (!gl) continue;
    const debug = gl.getExtension("WEBGL_debug_renderer_info");
    const info = {
      api,
      renderer: debug ? String(gl.getParameter(debug.UNMASKED_RENDERER_WEBGL)) : null,
      vendor: debug ? String(gl.getParameter(debug.UNMASKED_VENDOR_WEBGL)) : null
    };
    gl.getExtension("WEBGL_lose_context")?.loseContext();
    return info;
  }
  return { api: null, renderer: null, vendor: null };
}

export function requireHardwareRendering(env: Record<string, string | undefined>): boolean {
  return env[REQUIRE_HARDWARE_RENDERING_ENV] === "1";
}

export function hardwareRenderingDecision(info: WebglRendererInfo, requireHardware: boolean): HardwareRenderingDecision {
  // No WebGL at all is a failure of the browser setup, never a reason to skip.
  if (!info.api) return { action: "fail", reason: "webgl_unavailable: the browser created no WebGL context" };
  if (info.renderer && SOFTWARE_RENDERER_PATTERN.test(info.renderer)) {
    return requireHardware
      ? { action: "fail", reason: `hardware_rendering_required: software WebGL renderer "${info.renderer}" while ${REQUIRE_HARDWARE_RENDERING_ENV}=1` }
      : { action: "skip", reason: `requires hardware rendering; software WebGL renderer: ${info.renderer}` };
  }
  // An unidentified renderer is not treated as software: the scenario runs as usual.
  if (!info.renderer && requireHardware) {
    return { action: "fail", reason: `hardware_rendering_unconfirmed: WEBGL_debug_renderer_info unavailable while ${REQUIRE_HARDWARE_RENDERING_ENV}=1` };
  }
  return { action: "run", reason: null };
}
