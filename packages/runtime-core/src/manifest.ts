export interface RuntimeManifest {
  roomId: string;
  template: string;
  features: {
    voice: boolean;
    spatialAudio: boolean;
    screenShare: boolean;
  };
}

export function validateManifest(manifest: RuntimeManifest): boolean {
  return Boolean(manifest.roomId && manifest.template);
}
