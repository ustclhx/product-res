import { defineConfig } from '@playwright/test'
import base from './playwright.config.ts'

// 显式故障入口；默认 e2e、smoke 和普通 acceptance 配置均不收集它。
export default defineConfig({
  ...base,
  timeout: 40 * 60_000,
  workers: 1,
  retries: 0,
  use: { ...base.use, headless: false },
  projects: [{ name: 'fault-acceptance', testMatch: 'fault.spec.ts' }],
})
