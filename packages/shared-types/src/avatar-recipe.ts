export interface AvatarRecipeV1 {
  schemaVersion: 1;
  avatarId: string;
  rig: "humanoid-v1";
  bodyVariant: string;
  headVariant: string;
  hairVariant: string;
  outfitVariant: string;
  palette: {
    skin: string;
    primary: string;
    accent: string;
  };
  accessories: string[];
}

export interface AvatarRecipeCatalogV1 {
  schemaVersion: 1;
  recipes: AvatarRecipeV1[];
}
