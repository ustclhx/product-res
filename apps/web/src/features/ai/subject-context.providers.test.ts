import { describe, expect, it, vi } from 'vitest'

// add-subject-chat 审阅 B1：冷启动 isolate 上只调用签发入口（没有先加载对象对话模块）时，
// 项目注册文件也必须已被加载，否则签发会报「类型未注册」。
vi.mock('./subject-providers.ts', async () => {
  const { registerConversationSubject } = await import('./subjects.ts')
  registerConversationSubject('cold-start', { label: () => 'Cold start' })
  return {}
})

describe('issueSubjectContext on a cold isolate', () => {
  it('registers project providers when only the issuing module is imported', async () => {
    const { issueSubjectContext } = await import('./subject-context.ts')
    const store = new Map<string, string>()
    const issued = await issueSubjectContext(
      {
        secret: 'test-secret-0123456789-abcdefghijklmnopqrstuvwxyz',
        cache: {
          get: async (key: string) => store.get(key) ?? null,
          put: async (key: string, value: string) => {
            store.set(key, value)
          },
          delete: async () => {},
        } as never,
      },
      {
        userId: 'u',
        workspaceId: 'w',
        subjectType: 'cold-start',
        context: { version: 'v1', text: 'context' },
        returnTo: '/back',
      },
    )
    expect(issued.token).toContain('.')
  })
})
