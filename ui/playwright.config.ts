import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  outputDir: "./test-results/e2e",
  fullyParallel: false,
  workers: 1,
  use: {
    baseURL: "http://127.0.0.1:4183",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "chromium", use: { browserName: "chromium" }, testIgnore: /mobile\.spec\.ts/ },
    { name: "firefox", use: { browserName: "firefox" }, testIgnore: /mobile\.spec\.ts/ },
    { name: "webkit", use: { browserName: "webkit" }, testIgnore: /mobile\.spec\.ts/ },
    { name: "mobile-chrome", use: { ...devices["Pixel 7"] }, testMatch: /mobile\.spec\.ts/ },
    { name: "mobile-webkit", use: { ...devices["iPhone 13"] }, testMatch: /mobile\.spec\.ts/ },
  ],
  webServer: {
    command: "pnpm dev --host 127.0.0.1 --port 4183 --strictPort",
    url: "http://127.0.0.1:4183",
    reuseExistingServer: false,
    env: { VITE_API_BASE_URL: "/api" },
  },
});
