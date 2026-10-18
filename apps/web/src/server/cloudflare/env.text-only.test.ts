import { expect, it, vi } from 'vitest'

vi.mock('../template-config.ts', async (original) => {
  const { templateConfig } = await original<typeof import('../template-config.ts')>()
  return {
    templateConfig: {
      ...templateConfig,
      ai: { ...templateConfig.ai, image: false, video: false },
      auth: { ...templateConfig.auth, oauth: [], turnstile: false },
      features: { ...templateConfig.features, publicApi: false },
    },
  }
})

import { checkEnv } from './env.ts'

it('文本项目不需要已从 manifest 移除的媒体 Workflow 绑定', () => {
  const fn = () => undefined
  expect(
    checkEnv({
      HYPERDRIVE: { connectionString: 'postgres://offline' },
      EMAIL_QUEUE: { send: fn },
      CACHE: { get: fn, put: fn, delete: fn },
      RL_AUTH: { limit: fn },
      RL_AI: { limit: fn },
      APP_URL: 'https://text.example',
      BETTER_AUTH_SECRET: 'x'.repeat(32),
    }),
  ).toBeNull()
})
