import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: "*.spec.js",
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [["list"]],
  outputDir: "test-results",
  use: {
    browserName: "chromium",
    headless: true,
    // Test-only MagicDNS: keep both node names on loopback, without a system proxy.
    launchOptions: {
      args: [
        "--host-resolver-rules=MAP rowan-v2-dev 127.0.0.1, MAP rowan-v2-dev.example.ts.net 127.0.0.1",
        "--no-proxy-server",
      ],
    },
    viewport: { width: 1600, height: 1000 },
    serviceWorkers: "block",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
});
