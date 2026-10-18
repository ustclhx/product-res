import config from './vitest.config.ts'

if (!process.env.ENTITLEMENTS_TEST_DATABASE_URL || !process.env.MIGRATION_DATABASE_URL)
  throw new Error('Node entitlements tests require matching isolated database URLs')

export default config
