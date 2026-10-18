import config from './vitest.config.ts'

// Node 验收必须真正执行现有支付/账本用例，缺资源不能退化为离线测试。
if (!process.env.BILLING_TEST_DATABASE_URL || !process.env.MIGRATION_DATABASE_URL)
  throw new Error('Node billing tests require matching isolated database URLs')

export default config
