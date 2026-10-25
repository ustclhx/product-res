import { describe, expect, it } from 'vitest'
import { assertNotReadOnly } from '../data-center/access.ts'
import { assertWorkbenchWriter, canWriteWorkbench } from './access.ts'

describe('assertWorkbenchWriter', () => {
  it('可写空间的 owner / admin 可以修改', () => {
    for (const role of ['owner', 'admin']) {
      const ctx = { workspaceReadOnly: false, member: { role } }
      expect(() => assertWorkbenchWriter(ctx)).not.toThrow()
      expect(canWriteWorkbench(ctx)).toBe(true)
    }
  })

  it('member 被拒绝（403 FORBIDDEN）', () => {
    const ctx = { workspaceReadOnly: false, member: { role: 'member' } }
    expect(() => assertWorkbenchWriter(ctx)).toThrow(
      expect.objectContaining({ code: 'FORBIDDEN', status: 403 }),
    )
    expect(canWriteWorkbench(ctx)).toBe(false)
  })

  it('只读空间连 owner 也被拒绝（403 WORKSPACE_READ_ONLY）', () => {
    const ctx = { workspaceReadOnly: true, member: { role: 'owner' } }
    expect(() => assertWorkbenchWriter(ctx)).toThrow(
      expect.objectContaining({ code: 'WORKSPACE_READ_ONLY', status: 403 }),
    )
    expect(canWriteWorkbench(ctx)).toBe(false)
  })
})

it('流转错误优先于只读；数据中心普通成员的填写也被锁住，结束后恢复', () => {
  const context = {
    workspaceReadOnly: true,
    workspaceTransferring: true,
    member: { role: 'owner' },
  }
  expect(() => assertWorkbenchWriter(context)).toThrow(
    expect.objectContaining({ code: 'WORKSPACE_TRANSFERRING', status: 403 }),
  )
  expect(canWriteWorkbench(context)).toBe(false)
  expect(() => assertNotReadOnly({ ...context, member: { role: 'member' } })).toThrow(
    expect.objectContaining({ code: 'WORKSPACE_TRANSFERRING' }),
  )
  const unlocked = { ...context, workspaceReadOnly: false, workspaceTransferring: false }
  expect(() => assertWorkbenchWriter(unlocked)).not.toThrow()
  expect(() => assertNotReadOnly({ ...unlocked, member: { role: 'member' } })).not.toThrow()
})
