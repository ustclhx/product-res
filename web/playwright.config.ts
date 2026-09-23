import { defineConfig } from "@playwright/test";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const webRoot = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(webRoot, "..");
const dbPath = process.env.PRODUCT_RES_DB ?? path.join(os.tmpdir(), `product-res-e2e-${process.pid}.sqlite3`);
const chromePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

export default defineConfig({
  testDir: "./e2e",
  timeout: 90_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    actionTimeout: 10_000,
    baseURL: process.env.E2E_BASE_URL ?? "http://127.0.0.1:5174",
    browserName: "chromium",
    launchOptions: { executablePath: chromePath },
    ignoreHTTPSErrors: true,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    // Keep traces and screenshots self-contained; ffmpeg is not required on CI hosts.
    video: "off",
  },
  webServer: [
    {
      command: `${path.join(repoRoot, ".venv/bin/uvicorn")} app.main:app --host 127.0.0.1 --port 8001`,
      cwd: repoRoot,
      env: { ...process.env, PRODUCT_RES_DB: dbPath },
      url: "http://127.0.0.1:8001/api/v1/health",
      timeout: 120_000,
      reuseExistingServer: false,
    },
    {
      command: "npm run dev -- --host 127.0.0.1 --port 5174",
      cwd: webRoot,
      env: { ...process.env, VITE_API_TARGET: "http://127.0.0.1:8001" },
      url: "http://127.0.0.1:5174",
      timeout: 120_000,
      reuseExistingServer: false,
    },
  ],
});
