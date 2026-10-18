import { defineConfig } from '@playwright/test'
import base from './fault.local.config.ts'

export default defineConfig({
  ...base,
  projects: [{ name: 'fault-management-local', testMatch: 'fault-management.spec.ts' }],
})
