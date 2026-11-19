import { describe, expect, it, vi } from 'vitest'

// 冷导入中立入口时若误加载 Node SDK，立即失败；不 mock 发送行为。
vi.mock('nodemailer', () => {
  throw new Error('Neutral email entry loaded Node SMTP')
})
vi.mock('nodemailer/lib/addressparser', () => {
  throw new Error('Neutral email entry loaded Node address parser')
})

// 冷启动动态导入整个包与 React Email，CI 并行跑数据库测试时偶发超过默认 5 秒（PR #423 的 test-packages）
describe('email target import boundary', { timeout: 30_000 }, () => {
  it('keeps the root and producer entry independent of Node SMTP', async () => {
    const email = await import('../index.ts')
    const queue = await import('../queue.ts')
    expect(email.renderEmail).toBeTypeOf('function')
    expect(email.createResendSender).toBeTypeOf('function')
    expect(queue.parseEmailQueueMessage).toBeTypeOf('function')
    expect(email).not.toHaveProperty('createSmtpSender')
    expect(queue).not.toHaveProperty('createSmtpSender')
  })
})
