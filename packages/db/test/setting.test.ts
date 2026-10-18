import { env } from 'cloudflare:workers'
import { newId } from '@product-res/shared'
import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { createDb, dbSettingStore, getSetting, setting } from '../src/index.ts'

// 在 workerd 中经 Hyperdrive 绑定（localConnectionString → 本地 PG，app 账号）读写 setting 表。
describe('setting 表（Hyperdrive → 本地 Postgres）', () => {
  // 不调用 db.$client.end()：postgres.js 在 workerd 中关闭连接时会抛出未处理的
  // 「Stream was cancelled」（cf/polyfills.js）。连接随测试 isolate 一起回收，与生产中按请求创建一致。
  const open = () => createDb(env.HYPERDRIVE)

  it('插入、读取、更新、删除一行', async () => {
    const db = open()
    const key = `test.${newId()}`
    const [inserted] = await db
      .insert(setting)
      .values({ key, value: { n: 1 } })
      .returning()
    try {
      expect(inserted?.id).toMatch(/^[0-9a-f-]{36}$/)

      const [read] = await db.select().from(setting).where(eq(setting.key, key))
      expect(read?.value).toEqual({ n: 1 })

      const [updated] = await db
        .update(setting)
        .set({ value: { n: 2 } })
        .where(eq(setting.key, key))
        .returning()
      expect(updated?.value).toEqual({ n: 2 })
      expect(updated?.updatedAt.getTime()).toBeGreaterThanOrEqual(read?.updatedAt.getTime() ?? 0)
    } finally {
      await db.delete(setting).where(eq(setting.key, key))
    }
    expect(await db.select().from(setting).where(eq(setting.key, key))).toEqual([])
  })

  it('getSetting 读表中的值，删除后回退到代码默认值', async () => {
    const db = open()
    const store = dbSettingStore(db)
    const key = 'auth.signupEnabled'
    await db
      .insert(setting)
      .values({ key, value: false })
      .onConflictDoUpdate({ target: setting.key, set: { value: false } })
    try {
      expect(await getSetting({ store }, key)).toBe(false)
    } finally {
      await db.delete(setting).where(eq(setting.key, key))
    }
    expect(await getSetting({ store }, key)).toBe(true)
  })
})
