import config from './vitest.config.ts'

// 复用并发预扣、结算和回滚断言；显式 Node 验收不允许零用例成功。
if (!process.env.CREDITS_TEST_DATABASE_URL || !process.env.MIGRATION_DATABASE_URL)
  throw new Error('Node credits tests require matching isolated database URLs')

export default config
