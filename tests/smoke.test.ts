import { expect, test } from "vitest";
import { CONFIG } from "../src/config.js";

test("config has defaults", () => {
  expect(CONFIG.port).toBe(4179);
  expect(CONFIG.dataDir).toContain("data");
});
