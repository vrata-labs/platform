import { test } from "@playwright/test";
import { referenceTemplateScenarios } from "./reference-template-scenarios";

test.use({ trace: "off", video: "off" });
test.describe("@staging reference template product flows", () => {
  // The deploy gate starts at Wave 2, before reference create is available.
  // Activation sets this variable explicitly; subsequent gates detect catalog.
  test.skip(process.env.VRATA_REFERENCE_CATALOG_ACTIVE !== "1", "Wave 2 compatibility deployment precedes reference activation");
  referenceTemplateScenarios(true);
});
