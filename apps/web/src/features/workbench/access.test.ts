import { describe, expect, it } from 'vitest'
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
