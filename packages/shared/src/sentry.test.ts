import { expect, it } from 'vitest'
import { sentryBeforeSend, setLogContext, withLogContext } from './log.ts'

it('Sentry 事件脱敏且保留请求身份标签与源码堆栈', () => {
  const event = {
    tags: {},
    request: {
      url: 'https://app.test/api/chat?token=secret',
      method: 'POST',
      headers: { authorization: 'Bearer secret' },
      data: 'private conversation',
      cookies: 'session-secret',
    },
    user: { id: 'user-1', email: 'private@example.test', ip_address: '1.2.3.4' },
    breadcrumbs: [{ message: 'private conversation' }],
    exception: { values: [{ stacktrace: { frames: [{ filename: 'server.ts', lineno: 42 }] } }] },
  }
  const result = withLogContext({ requestId: 'request-1' }, () => {
    setLogContext({ workspaceId: 'workspace-1', userId: 'user-1' })
    return sentryBeforeSend(event)
  })
  expect(result.tags).toEqual({
    requestId: 'request-1',
    workspaceId: 'workspace-1',
    userId: 'user-1',
  })
  expect(result.user).toEqual({ id: 'user-1' })
  expect(result.exception).toEqual(event.exception)
  expect(JSON.stringify(result)).not.toMatch(
    /Bearer secret|private|session-secret|token=|1\.2\.3\.4/,
  )
  expect(event.request.data).toBe('private conversation')
})
