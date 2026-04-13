import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./test/e2e",
  timeout: 30_000,
  use: {
    baseURL: "http://127.0.0.1:3310",
    trace: "on-first-retry",
  },
  webServer: {
    command: "./scripts/start-e2e-web.sh",
    url: "http://127.0.0.1:3310",
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
