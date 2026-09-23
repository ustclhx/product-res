import { defineConfig } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const webRoot = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(webRoot, "..");
const chromePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

export default defineConfig({
  testDir: "./e2e-pilot",
  outputDir: "test-results-pilot",
  timeout: 120_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"], ["html", { open: "never", outputFolder: "playwright-report-pilot" }]],
  use: {
    actionTimeout: 15_000,
    baseURL: "http://127.0.0.1:5175",
    browserName: "chromium",
    launchOptions: { executablePath: chromePath },
    ignoreHTTPSErrors: true,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
  },
  webServer: [
    {
      command: `${path.join(repoRoot, ".venv/bin/python")} scripts/pilot_e2e_server.py --host 127.0.0.1 --port 8003`,
      cwd: repoRoot,
      env: { ...process.env, PYTHONPATH: repoRoot },
      url: "http://127.0.0.1:8003/api/v1/health",
      timeout: 120_000,
      reuseExistingServer: false,
    },
    {
      command: "npm run dev -- --host 127.0.0.1 --port 5175",
      cwd: webRoot,
      env: { ...process.env, VITE_API_TARGET: "http://127.0.0.1:8003" },
      url: "http://127.0.0.1:5175",
      timeout: 120_000,
      reuseExistingServer: false,
    },
  ],
});
