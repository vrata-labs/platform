/** The xr-standard squeeze button is sampled once, independently of select/teleport. */
export function sampleXrGripPressed(sources: readonly Pick<XRInputSource, "handedness" | "gamepad">[]) {
  return {
    left: sources.some(source => source.handedness === "left" && source.gamepad?.buttons[1]?.pressed === true),
    right: sources.some(source => source.handedness === "right" && source.gamepad?.buttons[1]?.pressed === true)
  };
}
