import type { Database } from '@product-res/db'
import { captureFirstTouch, encodeFirstTouch } from '@product-res/shared/analytics'
import { describe, expect, it, vi } from 'vitest'
import { createSignUpRecorder, enqueueServerAnalytics } from './server.ts'

function harness() {
  const rows: unknown[] = []
  const db = {
    insert: () => ({
      values: (row: unknown) => {
        rows.push(row)
        return { onConflictDoNothing: async () => {} }
      },
    }),
  } as unknown as Database
  const send = vi.fn(async () => {})
  return { rows, db, queue: { send } as never, send }
}
const touch = captureFirstTouch({
  url: new URL('https://a.example/guides/x?utm_source=chatgpt'),
  now: new Date('2026-10-31T00:00:00.000Z'),
})

describe('createSignUpRecorder', () => {
  it('把首触 Cookie 写入用户归因并投递 sign_up', async () => {
    const { rows, db, queue, send } = harness()
    await createSignUpRecorder({ db, queue, clientIp: '203.0.113.9' })(
      { id: 'u1' },
      new Headers({
        cookie: `other=1; product_res_ft=${encodeFirstTouch(touch)}`,
        'user-agent': 'UA',
      }),
    )
    expect(rows).toEqual([
      expect.objectContaining({ userId: 'u1', source: 'chatgpt', landingPath: '/guides/x' }),
    ])
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        v: 1,
        analytics: { event: 'sign_up', userId: 'u1', clientIp: '203.0.113.9', userAgent: 'UA' },
      }),
    )
  })

  it('Cookie 缺失或被篡改时不写归因，仍投递 sign_up', async () => {
    for (const cookie of ['', 'product_res_ft=%7Bbad'])
      await (async () => {
        const { rows, db, queue, send } = harness()
        await createSignUpRecorder({ db, queue })({ id: 'u1' }, new Headers({ cookie }))
        expect(rows).toEqual([])
        expect(send).toHaveBeenCalledTimes(1)
      })()
  })

  it('设置 GPC / DNT 时不写归因也不投递事件', async () => {
    for (const privacy of [{ 'sec-gpc': '1' }, { dnt: '1' }]) {
      const { rows, db, queue, send } = harness()
      await createSignUpRecorder({ db, queue })(
        { id: 'u1' },
        new Headers({ cookie: `product_res_ft=${encodeFirstTouch(touch)}`, ...privacy }),
      )
      expect(rows).toEqual([])
      expect(send).not.toHaveBeenCalled()
    }
  })

  it('归因写入失败时仍投递 sign_up', async () => {
    const { queue, send } = harness()
    const db = {
      insert: () => ({
        values: () => ({
          onConflictDoNothing: async () => {
            throw new Error('db down')
          },
        }),
      }),
    } as unknown as Database
    await createSignUpRecorder({ db, queue })(
      { id: 'u1' },
      new Headers({ cookie: `product_res_ft=${encodeFirstTouch(touch)}` }),
    )
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('队列故障不影响注册', async () => {
    const send = vi.fn(async () => {
      throw new Error('down')
    })
    await expect(
      enqueueServerAnalytics({ send } as never, { event: 'sign_up', userId: 'u1' }),
    ).resolves.toBeUndefined()
  })
})
