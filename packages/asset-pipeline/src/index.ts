export interface AssetBudget {
  quality: "mobile-lite" | "desktop-standard" | "xr";
  maxSceneSizeMb: number;
}

export const defaultBudgets: AssetBudget[] = [
  { quality: "mobile-lite", maxSceneSizeMb: 15 },
  { quality: "desktop-standard", maxSceneSizeMb: 40 },
  { quality: "xr", maxSceneSizeMb: 25 }
];

export * from "./validator.js";
export * from "./presets.js";
