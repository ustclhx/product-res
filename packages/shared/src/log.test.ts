import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  currentRequestId,
  log,
  newRequestId,
  setLogContext,
  withLogContext,
  withRequestId,
} from './log.ts'

const lines = () => {
  const spies = [
    vi.spyOn(console, 'log').mockImplementation(() => {}),
    vi.spyOn(console, 'warn').mockImplementation(() => {}),
    vi.spyOn(console, 'error').mockImplementation(() => {}),
  ]
  return () => spies.flatMap((spy) => spy.mock.calls.map(([line]) => JSON.parse(line as string)))
}

afterEach(() => vi.restoreAllMocks())

describe('structured log', () => {
  it('writes one JSON line with level, event, context and fields', async () => {
    const read = lines()
    const requestId = newRequestId()
    await withLogContext({ requestId, route: '/api/x' }, async () => {
      await Promise.resolve()
      setLogContext({ workspaceId: 'w1', userId: 'u1' })
      log.warn('thing.happened', { count: 2 })
    })
    log.info('outside')
    expect(read()).toEqual([
      { level: 'info', event: 'outside' },
      {
        level: 'warn',
        event: 'thing.happened',
        requestId,
        route: '/api/x',
        workspaceId: 'w1',
        userId: 'u1',
        count: 2,
      },
    ])
  })

  it('serializes errors and redacts sensitive fields', () => {
    const read = lines()
    log.error('failed', { error: new TypeError('boom'), authorization: 'Bearer x' })
    const [line] = read()
    expect(line).toMatchObject({
      level: 'error',
      error: { name: 'TypeError', message: 'boom' },
      authorization: '[REDACTED]',
    })
  })

  it('never throws when a field cannot be serialized', () => {
    const read = lines()
    const fields = {
      get broken(): never {
        throw new Error('getter')
      },
    }
    withLogContext({ requestId: 'r1' }, () => log.info('odd', fields))
    expect(read()).toEqual([{ level: 'info', event: 'odd', requestId: 'r1', logError: true }])
  })

  it('nests contexts without leaking into the parent and isolates concurrent requests', async () => {
    const seen: (string | undefined)[] = []
    await Promise.all(
      ['a', 'b'].map((requestId) =>
        withLogContext({ requestId }, async () => {
          await new Promise((resolve) => setTimeout(resolve, requestId === 'a' ? 5 : 0))
          withLogContext({ job: 'child' }, () => setLogContext({ userId: 'child-only' }))
          seen.push(currentRequestId())
        }),
      ),
    )
    expect(seen.sort()).toEqual(['a', 'b'])
    expect(currentRequestId()).toBeUndefined()
  })

  it('adds the current request ID to queue messages only inside a request', () => {
    expect(withRequestId({ v: 1 })).toEqual({ v: 1 })
    expect(withLogContext({ requestId: 'r1' }, () => withRequestId({ v: 1 }))).toEqual({
      v: 1,
      requestId: 'r1',
    })
  })
})
