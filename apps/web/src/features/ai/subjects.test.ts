import { describe, expect, it } from 'vitest'
import {
  registerConversationSubject,
  resolveConversationSubject,
  type SubjectRequestContext,
  subjectLabel,
} from './subjects.ts'

// add-subject-chat tasks.md 2.1：注册表的类型校验、重复注册与统一 404（返回 null）语义。

const ctx = { workspaceId: 'w', userId: 'u', locale: 'zh' } as SubjectRequestContext

describe('conversation subject registry', () => {
  it('validates types and refuses duplicates', () => {
    expect(() => registerConversationSubject('Bad Type', { label: () => 'x' })).toThrow()
    const off = registerConversationSubject('note', {
      label: (l) => (l === 'zh' ? '笔记' : 'Note'),
    })
    expect(() => registerConversationSubject('note', { label: () => 'x' })).toThrow()
    expect(subjectLabel('note', 'zh')).toBe('笔记')
    expect(subjectLabel('gone', 'zh')).toBe('gone')
    expect(subjectLabel(null, 'zh')).toBeNull()
    off()
    expect(subjectLabel('note', 'en')).toBe('note')
  })

  it('returns null for unknown types, types without resolve and denied objects', async () => {
    const offTemp = registerConversationSubject('temp', { label: () => 'Temp' })
    const offOwned = registerConversationSubject('owned', {
      label: () => 'Owned',
      resolve: async (c, id) =>
        c.userId === 'u' && id === 'mine'
          ? { context: async () => ({ version: '1', text: 't' }) }
          : null,
    })
    expect(await resolveConversationSubject(ctx, 'missing', 'mine')).toBeNull()
    expect(await resolveConversationSubject(ctx, 'temp', 'mine')).toBeNull()
    expect(await resolveConversationSubject(ctx, 'owned', 'theirs')).toBeNull()
    expect(
      await resolveConversationSubject({ ...ctx, userId: 'other' }, 'owned', 'mine'),
    ).toBeNull()
    expect(await resolveConversationSubject(ctx, 'owned', 'x'.repeat(200))).toBeNull()
    expect(await resolveConversationSubject(ctx, 'owned', 'mine')).not.toBeNull()
    offTemp()
    offOwned()
  })
})
