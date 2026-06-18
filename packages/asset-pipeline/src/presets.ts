export interface ConversionPreset {
  id: string;
  description: string;
}

export const texturePreset: ConversionPreset = {
  id: "texture-ktx2-default",
  description: "Convert textures to KTX2 for runtime delivery"
};

export const meshPreset: ConversionPreset = {
  id: "mesh-meshopt-default",
  description: "Compress geometry using meshopt defaults"
};
