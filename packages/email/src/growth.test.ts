import { describe, expect, it, vi } from 'vitest'
import { parseEmailQueueMessage } from './queue.ts'
import { renderEmail } from './render.tsx'
import { createResendSender } from './resend.ts'

describe('growth email', () => {
  it('renders invitation and confirmation links in both languages and validates queue input', async () => {
    for (const locale of ['en', 'zh'])
      for (const template of ['waitlist-invitation', 'newsletter-confirmation'] as const) {
        const props = { url: 'https://example.test/link?token=signed' }
        const message = {
          v: 1,
          template,
          props,
          to: 'guest@example.test',
          locale,
          appName: 'Test',
          idempotencyKey: 'growth-test',
        }
        expect(parseEmailQueueMessage(message)).toEqual(message)
        const rendered = await renderEmail(template, props, { locale, appName: 'Test' })
        expect(rendered.html).toContain(props.url)
        expect(rendered.text).toContain(props.url)
        expect(rendered.headers).toBeUndefined()
      }
  })

  it('includes the one-click link and sends only whitelisted unsubscribe headers to Resend', async () => {
    const unsubscribeUrl = 'https://example.test/api/newsletter/unsubscribe?token=signed'
    const rendered = await renderEmail(
      'newsletter',
      { subject: 'News', body: 'Our latest update', unsubscribeUrl },
      { locale: 'en', appName: 'Test' },
    )
    expect(rendered.html).toContain(unsubscribeUrl)
    expect(rendered.text).toContain(unsubscribeUrl)
    const doFetch = vi.fn(async () => Response.json({ id: 'sent' }))
    const sender = createResendSender({ apiKey: 'fake', from: 'test@example.test', fetch: doFetch })
    await sender.send({
      to: 'guest@example.test',
      ...rendered,
      headers: { ...rendered.headers, 'X-Unsafe': 'discard' } as NonNullable<
        typeof rendered.headers
      >,
    })
    const call = doFetch.mock.calls[0] as unknown as [unknown, RequestInit]
    expect(JSON.parse(call[1].body as string).headers).toEqual({
      'List-Unsubscribe': `<${unsubscribeUrl}>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    })
    await expect(
      sender.send({
        to: 'guest@example.test',
        ...rendered,
        headers: { 'List-Unsubscribe': 'bad\r\nInjected: header' },
      }),
    ).rejects.toThrow('Invalid email header')
  })
})
