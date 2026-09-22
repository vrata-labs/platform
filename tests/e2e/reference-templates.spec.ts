import { test } from "@playwright/test";
import { referenceTemplateScenarios } from "./reference-template-scenarios";

test.use({ trace: "off", video: "off" });
referenceTemplateScenarios(false);
