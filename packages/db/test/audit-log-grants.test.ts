import { env } from 'cloudflare:workers'
import { newId } from '@product-res/shared'
import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { auditLog, createDb } from '../src/index.ts'

// add-admin-console tasks.md 1.2：audit_log 只追加（迁移 0009_audit_log_append_only）。
// 应用运行时的 app 账号只能 INSERT / SELECT，UPDATE / DELETE 由数据库拒绝（42501 权限不足）。

async function pgCode(query: PromiseLike<unknown>): Promise<string | undefined> {
  const error = await Promise.resolve(query).then(
    () => null,
    (e: unknown) => e,
  )
  expect(error).not.toBeNull()
  return ((error as { cause?: { code?: string } }).cause ?? (error as { code?: string })).code
}

describe('audit_log 只追加（app 账号）', () => {
  it('INSERT 成功，UPDATE / DELETE 被数据库拒绝', async () => {
    const db = createDb(env.HYPERDRIVE)
    const action = `test.append_only.${newId()}`
    const [row] = await db
      .insert(auditLog)
      .values({ action, meta: { n: 1 } })
      .returning()
    try {
      expect(row?.action).toBe(action)

      expect(
        await pgCode(
          db
            .update(auditLog)
            .set({ meta: { n: 2 } })
            .where(eq(auditLog.action, action)),
        ),
      ).toBe('42501')
      expect(await pgCode(db.delete(auditLog).where(eq(auditLog.action, action)))).toBe('42501')
      expect(await pgCode(db.$client`truncate audit_log`)).toBe('42501')

      const [kept] = await db.select().from(auditLog).where(eq(auditLog.action, action))
      expect(kept?.meta).toEqual({ n: 1 })
    } finally {
      await createDb(env.HYPERDRIVE_MIGRATOR).delete(auditLog).where(eq(auditLog.action, action))
    }
  })
})
