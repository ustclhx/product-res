import { afterAll } from 'vitest'
import { env } from './env.ts'

afterAll(async () => {
  await Promise.all([env.HYPERDRIVE.end(), env.HYPERDRIVE_MIGRATOR.end()])
})
