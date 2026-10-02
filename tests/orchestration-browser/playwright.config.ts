import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: "*.spec.mjs",
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  expect: { timeout: 8_000 },
  reporter: [["list"]],
  outputDir: "test-results",
  use: {
    browserName: "chromium",
    headless: true,
    viewport: { width: 1600, height: 1050 },
    serviceWorkers: "block",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
});
