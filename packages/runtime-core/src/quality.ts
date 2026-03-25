export type QualityProfile = "mobile-lite" | "desktop-standard" | "xr";

export function resolveQualityProfile(mode: "desktop" | "mobile" | "vr"): QualityProfile {
  if (mode === "mobile") {
    return "mobile-lite";
  }

  if (mode === "vr") {
    return "xr";
  }

  return "desktop-standard";
}
