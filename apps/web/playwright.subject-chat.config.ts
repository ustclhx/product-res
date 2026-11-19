import { defineConfig } from '@playwright/test'
import base from './playwright.config.ts'

// 嵌入式 SubjectChat 的 e2e（add-ai-chat-components 5.2）：用 e2e/subject-chat/vite.ts 启动隔离的 dev 服务器
// （登记测试对象类型、临时上下文页换成嵌入 SubjectChat 的页面）。只在本地运行。
if (process.env.STAGING_URL || process.env.PRODUCTION_URL)
  throw new Error('Subject chat e2e only supports the isolated local server')

const log = process.env.E2E_AUTH_LOG ?? '/tmp/subject-chat-e2e.log'

export default defineConfig({
  ...base,
  testMatch: 'subject-chat.spec.ts',
  testIgnore: ['**/staging/**', '**/production/**'],
  webServer: {
    ...(Array.isArray(base.webServer) ? base.webServer[0] : base.webServer),
    command: `pnpm exec vite dev --config e2e/subject-chat/vite.ts > '${log}' 2>&1`,
    reuseExistingServer: false,
  },
})
