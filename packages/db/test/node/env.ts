import postgres from 'postgres'

const appUrl = process.env.NODE_DB_TEST_URL
const migrationUrl = process.env.MIGRATION_DATABASE_URL
if (!appUrl || !migrationUrl) throw new Error('Node DB tests require both database URLs')

// 进程资源供多个请求 facade 借用，测试结束由 owner 关闭。
export const env = {
  HYPERDRIVE: postgres(appUrl, { max: 3, prepare: true, fetch_types: false }),
  HYPERDRIVE_MIGRATOR: postgres(migrationUrl, { max: 1, prepare: true, fetch_types: false }),
}
