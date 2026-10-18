import { createServerFn } from '@tanstack/react-start'
import { getRequest } from '@tanstack/react-start/server'
import { z } from 'zod'
import { getWebRuntime } from '../../server/runtime.ts'
import { templateConfig } from '../../server/template-config.ts'
import {
  createKeySchema,
  createWorkspaceKey,
  editKeySchema,
  editWorkspaceKey,
  listWorkspaceKeys,
} from './service.ts'

function deps() {
  const runtime = getWebRuntime()
  return { db: runtime.db, auth: runtime.auth, config: templateConfig }
}
export const listKeys = createServerFn({ method: 'GET' })
  .validator(
    z.object({
      slug: z.string().min(1).max(64),
      page: z.number().int().min(0).max(10000).default(0),
    }),
  )
  .handler(({ data }) => listWorkspaceKeys(getRequest().headers, data.slug, data.page, deps()))
export const createKey = createServerFn({ method: 'POST' })
  .validator(createKeySchema)
  .handler(({ data }) => createWorkspaceKey(getRequest().headers, data, deps()))
export const editKey = createServerFn({ method: 'POST' })
  .validator(editKeySchema)
  .handler(({ data }) => editWorkspaceKey(getRequest().headers, data, deps()))
