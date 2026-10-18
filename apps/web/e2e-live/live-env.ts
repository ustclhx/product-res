import { createRequire } from 'node:module'
import type { Database } from '@product-res/db'
import { fixtureDb } from '../e2e/fixtures.ts'

// 真实支付 e2e 的运行目标：设置 STAGING_URL 时针对已部署的 staging，否则针对本 worktree 的本地 web。
// 两种目标共用同一组用例，只在「怎么起服务、回调怎么到达、去哪里核对数据库」上不同。
export const stagingUrl = process.env.STAGING_URL?.replace(/\/$/, '') || undefined
export const liveTarget: 'local' | 'staging' = stagingUrl ? 'staging' : 'local'

const require = createRequire(new URL('../../../packages/db/package.json', import.meta.url))

/**
 * 核对入账结果用的数据库连接。本地复用 worktree 隔离库；staging 只接受 `readonly` 账号的连接串
 * （STAGING_READONLY_DATABASE_URL），用例只读不写，避免误改 staging 数据。连接串不进日志或报错。
 */
export function liveDb(): Database['$client'] {
  if (liveTarget === 'local') return fixtureDb()
  const url = process.env.STAGING_READONLY_DATABASE_URL
  if (!url) throw new Error('Staging live e2e requires STAGING_READONLY_DATABASE_URL')
  if (new URL(url).username !== 'readonly')
    throw new Error('STAGING_READONLY_DATABASE_URL must use the readonly role')
  const postgres = require('postgres') as (
    url: string,
    options: { max: number; ssl: 'require' },
  ) => Database['$client']
  return postgres(url, { max: 1, ssl: 'require' })
}
