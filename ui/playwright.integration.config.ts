import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./integration", outputDir: "./test-results/integration", workers: 1, timeout: 45_000,
  use: { baseURL: "http://127.0.0.1:4184", trace: "retain-on-failure", screenshot: "only-on-failure" },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }, { name: "firefox", use: { browserName: "firefox" } }, { name: "webkit", use: { browserName: "webkit" } }],
  webServer: { command: "pnpm dev --host 127.0.0.1 --port 4184 --strictPort", url: "http://127.0.0.1:4184", reuseExistingServer: false, env: { VITE_API_BASE_URL: "http://127.0.0.1:18787/v1" } },
});
