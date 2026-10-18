import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDb } from '@product-res/db'
import { createNodeJobEngine } from '../../../src/node/job-engine.ts'

const url = process.env.TEST_JOB_OLD_DATABASE_URL
if (!url) throw new Error('Isolated old schema database required')
const db = createDb(url, { max: 1 })
const directory = await mkdtemp(join(tmpdir(), 'job-schema-'))
try {
  const engine = await createNodeJobEngine({
    database: db,
    databaseUrl: url,
    executorId: randomUUID(),
    applicationVersion: 'schema-probe-v1',
    ownershipDirectory: directory,
    shutdownTimeoutMs: 100,
  })
  console.info(JSON.stringify({ status: 'started' }))
  await engine.close()
} catch (error) {
  console.info(
    JSON.stringify({
      status: 'rejected',
      code: error && typeof error === 'object' && 'code' in error ? error.code : 'UNKNOWN',
    }),
  )
} finally {
  await db.close()
  await rm(directory, { recursive: true, force: true })
}
