import { createDb } from '@product-res/db'
import { createNodeBackgroundTasks } from '@product-res/platform/node'
import { afterAll, afterEach, beforeEach, describe, expect } from 'vitest'
import { registerAiChatSuite } from '../fixtures/ai-chat.suite.ts'
import { createChatTransportFixture } from '../fixtures/ai-chat-transport.ts'

const databaseUrl = process.env.NODE_AI_DATABASE_URL
if (!databaseUrl) throw new Error('Missing Node AI database URL')
const db = createDb(databaseUrl, { max: 3 })
afterAll(() => db.close())
const runtime = {
  rateLimiter: { limit: async () => ({ success: true }) },
  background: () => {
    const tasks = createNodeBackgroundTasks()
    return {
      ...tasks,
      settled: async () => {
        expect(await tasks.drain(5000)).toEqual({
          completed: true,
          pendingTasks: 0,
          activeRequests: 0,
        })
      },
    }
  },
}

// 两出口复用完整账本断言与真实 Node 后台排空；生产 HTTP 断开仍等待组 5 入口。
for (const env of [
  {
    AI_TEXT_EGRESS: 'direct' as const,
    OPENAI_BASE_URL: 'https://fixture.example/v1',
    OPENAI_API_KEY: 'fixture-key',
  },
  {
    AI_TEXT_EGRESS: 'gateway' as const,
    AI_GATEWAY_ACCOUNT_ID: 'account',
    AI_GATEWAY_ID: 'gateway',
    AI_GATEWAY_TOKEN: 'fixture-token',
  },
]) {
  describe(`${env.AI_TEXT_EGRESS} transport + Node settlement`, () => {
    const transport = createChatTransportFixture(env)
    beforeEach(() => transport.install())
    afterEach(() => transport.restore())
    registerAiChatSuite(db, {
      ...runtime,
      modelProvider: 'openai',
      mockFactory: (mock) => transport.factory(mock),
    })
  })
}
