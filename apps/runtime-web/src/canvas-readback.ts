/** Read the displayed WebGL2 framebuffer without synchronously waiting for GPU
 * completion. MSAA resolve and scaling are separate operations; only the small
 * diagnostic image crosses back to JavaScript. */
export async function readCanvasPixels(canvas: HTMLCanvasElement): Promise<{
  width: number; height: number; data: Uint8ClampedArray<ArrayBuffer>;
} | null> {
  const gl = canvas.getContext("webgl2");
  if (!gl || gl.isContextLost()) return null;
  const sourceWidth = gl.drawingBufferWidth, sourceHeight = gl.drawingBufferHeight;
  if (!sourceWidth || !sourceHeight) return null;
  const width = Math.min(320, sourceWidth), height = Math.min(180, sourceHeight);
  const attributes = gl.getContextAttributes();
  if (!attributes) return null;
  const textures: WebGLTexture[] = [], framebuffers: WebGLFramebuffer[] = [];
  let buffer: WebGLBuffer | null = null, sync: WebGLSync | null = null;
  try {
    // These bindings belong to the renderer. Restore them before yielding, not
    // after the fence: later frames may have established entirely new state.
    const read = gl.getParameter(gl.READ_FRAMEBUFFER_BINDING) as WebGLFramebuffer | null;
    const draw = gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING) as WebGLFramebuffer | null;
    const texture = gl.getParameter(gl.TEXTURE_BINDING_2D) as WebGLTexture | null;
    const unpack = gl.getParameter(gl.PIXEL_UNPACK_BUFFER_BINDING) as WebGLBuffer | null;
    const pack = gl.getParameter(gl.PIXEL_PACK_BUFFER_BINDING) as WebGLBuffer | null;
    const packParameters = [gl.PACK_ALIGNMENT, gl.PACK_ROW_LENGTH, gl.PACK_SKIP_PIXELS, gl.PACK_SKIP_ROWS];
    const packValues = packParameters.map(parameter => gl.getParameter(parameter) as number);
    const scissor = gl.isEnabled(gl.SCISSOR_TEST);
    let defaultReadBuffer: number | undefined;
    try {
      gl.bindBuffer(gl.PIXEL_UNPACK_BUFFER, null);
      const attachment = (w: number, h: number, opaque: boolean) => {
        const image = gl.createTexture();
        if (!image) return null;
        textures.push(image); gl.bindTexture(gl.TEXTURE_2D, image);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texImage2D(gl.TEXTURE_2D, 0, opaque ? gl.RGB8 : gl.RGBA8, w, h, 0, opaque ? gl.RGB : gl.RGBA, gl.UNSIGNED_BYTE, null);
        const framebuffer = gl.createFramebuffer();
        if (!framebuffer) return null;
        framebuffers.push(framebuffer); gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, image, 0);
        return gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE ? framebuffer : null;
      };
      // An opaque default framebuffer requires RGB8 for a compatible MSAA
      // resolve. RGBA8 here silently produced invalid/black captures in Chromium.
      const resolved = attachment(sourceWidth, sourceHeight, !attributes.alpha);
      const tiny = attachment(width, height, false);
      buffer = gl.createBuffer();
      if (!resolved || !tiny || !buffer) return null;
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, buffer);
      gl.bufferData(gl.PIXEL_PACK_BUFFER, width * height * 4, gl.STREAM_READ);
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
      defaultReadBuffer = gl.getParameter(gl.READ_BUFFER) as number;
      gl.readBuffer(gl.BACK);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, resolved);
      gl.disable(gl.SCISSOR_TEST);
      gl.blitFramebuffer(0, 0, sourceWidth, sourceHeight, 0, 0, sourceWidth, sourceHeight, gl.COLOR_BUFFER_BIT, gl.NEAREST);
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, resolved);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, tiny);
      gl.blitFramebuffer(0, 0, sourceWidth, sourceHeight, 0, 0, width, height, gl.COLOR_BUFFER_BIT, gl.LINEAR);
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, tiny);
      for (const parameter of packParameters) gl.pixelStorei(parameter, parameter === gl.PACK_ALIGNMENT ? 1 : 0);
      gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, 0);
      // WebGL allocation/read failures set error flags without throwing. A fence
      // proves completion, not success. Do not pre-clear errors: an existing
      // renderer error conservatively invalidates this observation too.
      if (gl.isContextLost() || gl.getError() !== gl.NO_ERROR) return null;
      sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
      if (!sync) return null;
      gl.flush();
    } finally {
      if (defaultReadBuffer !== undefined) {
        gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null); gl.readBuffer(defaultReadBuffer);
      }
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, read); gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, draw);
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.bindBuffer(gl.PIXEL_UNPACK_BUFFER, unpack); gl.bindBuffer(gl.PIXEL_PACK_BUFFER, pack);
      packParameters.forEach((parameter, index) => gl.pixelStorei(parameter, packValues[index]));
      if (scissor) gl.enable(gl.SCISSOR_TEST); else gl.disable(gl.SCISSOR_TEST);
    }
    // A lost or non-completing context must not retain a report and GPU storage
    // forever. This bounds only observational readback, never runtime leases.
    const deadline = performance.now() + 10_000;
    for (;;) {
      await new Promise<void>(resolve => setTimeout(resolve, 16));
      if (gl.isContextLost() || gl.drawingBufferWidth !== sourceWidth || gl.drawingBufferHeight !== sourceHeight) return null;
      const status = gl.clientWaitSync(sync, 0, 0);
      if (status === gl.ALREADY_SIGNALED || status === gl.CONDITION_SATISFIED) break;
      if (status !== gl.TIMEOUT_EXPIRED || performance.now() >= deadline) return null;
    }
    const pixels = new Uint8Array(width * height * 4);
    const currentPack = gl.getParameter(gl.PIXEL_PACK_BUFFER_BINDING) as WebGLBuffer | null;
    try {
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, buffer);
      gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, pixels);
      if (gl.isContextLost() || gl.getError() !== gl.NO_ERROR) return null;
    } finally { gl.bindBuffer(gl.PIXEL_PACK_BUFFER, currentPack); }
    const data = new Uint8ClampedArray(pixels.length);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const source = (y * width + x) * 4, target = ((height - 1 - y) * width + x) * 4;
        const alpha = pixels[source + 3];
        const scale = attributes.premultipliedAlpha ? (alpha ? 255 / alpha : 0) : 1;
        for (let channel = 0; channel < 3; channel++) data[target + channel] = Math.round(pixels[source + channel] * scale);
        data[target + 3] = alpha;
      }
    }
    return { width, height, data };
  } finally {
    if (sync) gl.deleteSync(sync);
    if (buffer) gl.deleteBuffer(buffer);
    for (const framebuffer of framebuffers) gl.deleteFramebuffer(framebuffer);
    for (const texture of textures) gl.deleteTexture(texture);
  }
}
