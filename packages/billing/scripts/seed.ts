#!/usr/bin/env -S node --experimental-strip-types
import { createDb } from '@product-res/db'
import { readLocalEnv } from '@product-res/db/worktree-env'
import { seedCatalog } from '../src/catalog.ts'

const url = readLocalEnv('CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE')
if (!url) throw new Error('Missing local billing database URL')
const db = createDb({ connectionString: url })
try {
  await seedCatalog(db)
  console.log('Seeded template example catalog; unsynced prices remain inactive.')
} finally {
  await db.$client.end()
}
