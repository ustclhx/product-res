import { getLogContext, withLogContext } from '@product-res/shared/log'
import { expect, it } from 'vitest'
import { initializeNodeObservability } from './observability.ts'
import { bridgeNodeObserver } from './observer-context.ts'

it('bridges independent bundle context snapshots into isolated safe envelopes', async () => {
  const envelopes: unknown[] = []
  const adapter = await initializeNodeObservability(
    {
      dsn: 'http://fixture@localhost/1',
      environment: 'smoke',
      release: 'a'.repeat(40),
    },
    () => ({
      send: async (envelope) => {
        envelopes.push(envelope)
        return { statusCode: 200 }
      },
      flush: async () => true,
    }),
  )
  try {
    const observer = bridgeNodeObserver(adapter)
    await Promise.all(
      ['one', 'two'].map(async (id) => {
        await Promise.resolve()
        observer.run(() =>
          observer.captureError(
            new Error('Cookie: secret-cookie SMTP_PASSWORD=private-password mail body'),
            { requestId: id, workspaceId: id, userId: id },
          ),
        )
      }),
    )
    const businessError = new Error('private driver body')
    observer.captureError(
      businessError,
      { requestId: 'business' },
      { code: 'STORAGE_FAILED', status: 500 },
    )
    observer.captureError(
      businessError,
      { requestId: 'business' },
      { code: 'STORAGE_FAILED', status: 500 },
    )
    observer.captureError(new Error('private not found'), {}, { code: 'NOT_FOUND', status: 404 })
    await adapter.client?.flush(1_000)
    const events = envelopes.flatMap((envelope) =>
      (envelope as [unknown, [unknown, unknown][]])[1]
        .filter(([header]) => (header as { type: string }).type === 'event')
        .map(([, event]) => event as { tags: Record<string, string> }),
    )
    expect(events).toHaveLength(3)
    expect(events).toContainEqual(
      expect.objectContaining({
        tags: expect.objectContaining({ requestId: 'business', code: 'STORAGE_FAILED' }),
      }),
    )
    expect(events.map((event) => event.tags)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ requestId: 'one', workspaceId: 'one', userId: 'one' }),
        expect.objectContaining({ requestId: 'two', workspaceId: 'two', userId: 'two' }),
      ]),
    )
    expect(JSON.stringify(envelopes)).not.toMatch(/secret-cookie|private-password|mail body/)
    expect(withLogContext({ requestId: 'outer' }, () => getLogContext().requestId)).toBe('outer')
    expect(getLogContext().requestId).toBeUndefined()
  } finally {
    await adapter.client?.close(1_000)
  }
})
