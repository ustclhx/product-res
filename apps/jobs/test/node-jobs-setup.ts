import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import setupDatabase from '@product-res/db/test/global-setup'

export default async function setup() {
  const appMigrator = process.env.MIGRATION_DATABASE_URL
  const jobMigrator = process.env.TEST_JOB_MIGRATOR_URL ?? appMigrator
  if (!appMigrator || !jobMigrator) throw new Error('Isolated migrator configuration required')
  for (const url of new Set([appMigrator, jobMigrator])) {
    process.env.MIGRATION_DATABASE_URL = url
    await setupDatabase()
    execFileSync('pnpm', ['--filter', '@product-res/platform', 'dbos:migrate'], {
      cwd: fileURLToPath(new URL('../../../', import.meta.url)),
      env: { ...process.env, MIGRATION_DATABASE_URL: url },
      stdio: 'inherit',
    })
  }
  process.env.MIGRATION_DATABASE_URL = appMigrator
}
