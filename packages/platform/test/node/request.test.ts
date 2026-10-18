import { log } from '@product-res/shared/log'
import { describe, expect, it, vi } from 'vitest'
import { createNodeRequestMetadata, withNodeRequestContext } from '../../src/node/index.ts'

const request = (xff?: string) =>
  new Request('https://example.test', {
    headers: {
      ...(xff === undefined ? {} : { 'x-forwarded-for': xff }),
      'cf-connecting-ip': '192.0.2.99',
    },
  })

describe('Node ingress metadata', () => {
  it('ignores forged headers unless the TCP peer is trusted', () => {
    const metadata = createNodeRequestMetadata(['10.0.1.0/24'])
    expect(metadata(request('192.0.2.3'), '203.0.113.4').clientIp).toBe('203.0.113.4')
    expect(createNodeRequestMetadata()(request('192.0.2.3'), '10.0.1.2').clientIp).toBe('10.0.1.2')
    expect(metadata(request('192.0.2.3'), undefined).clientIp).toBeNull()
  })

  it('walks from the right and stops at the first untrusted hop', () => {
    const metadata = createNodeRequestMetadata(['10.0.1.0/24', '2001:db8:1::/64'])
    expect(metadata(request('192.0.2.99, 203.0.113.4, 10.0.1.3'), '10.0.1.2').clientIp).toBe(
      '203.0.113.4',
    )
    expect(metadata(request('192.0.2.99, 2001:db8:1::2'), '2001:db8:1::1').clientIp).toBe(
      '192.0.2.99',
    )
    expect(metadata(request('192.0.2.99'), '::ffff:10.0.1.2').clientIp).toBe('192.0.2.99')
    expect(metadata(request('::ffff:c000:263'), '10.0.1.2').clientIp).toBe('192.0.2.99')
  })

  it.each(['fake, 192.0.2.3', '192.0.2.3,', '192.0.2.3:80', '[2001:db8::1]', 'fe80::1%eth0'])(
    'rejects the entire malformed chain %s',
    (xff) => {
      expect(createNodeRequestMetadata(['10.0.1.0/24'])(request(xff), '10.0.1.2').clientIp).toBe(
        '10.0.1.2',
      )
    },
  )

  it('rejects invalid trust configuration before serving requests', () => {
    expect(() => createNodeRequestMetadata(['10.0.1.0/33'])).toThrow('Invalid trusted proxy CIDR')
  })

  it('generates IDs and correlates response/logs without trusting supplied IDs', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      const metadata = createNodeRequestMetadata()(
        new Request('https://example.test', {
          headers: { 'x-request-id': 'forged', 'cf-ray': 'diagnostic-ray' },
        }),
        '127.0.0.1',
      )
      const response = await withNodeRequestContext(metadata, async () => {
        await Promise.resolve()
        log.info('request.test')
        return new Response('ok', { status: 201 })
      })
      expect(response.headers.get('x-request-id')).toBe(metadata.requestId)
      expect(metadata.requestId).not.toBe('forged')
      expect(JSON.parse(spy.mock.calls[0]?.[0] as string)).toMatchObject({
        requestId: metadata.requestId,
        cfRay: 'diagnostic-ray',
      })
      expect(await response.text()).toBe('ok')
      const withoutCf = createNodeRequestMetadata()(request(), '127.0.0.1')
      expect(withoutCf.cfRay).toBeUndefined()
      expect(withoutCf.requestId).not.toBe(metadata.requestId)
      const plainResponse = await withNodeRequestContext(withoutCf, () => {
        log.info('request.without_cf')
        return new Response('plain')
      })
      expect(plainResponse.headers.get('x-request-id')).toBe(withoutCf.requestId)
      expect(JSON.parse(spy.mock.calls[1]?.[0] as string)).toEqual({
        level: 'info',
        event: 'request.without_cf',
        requestId: withoutCf.requestId,
      })
    } finally {
      spy.mockRestore()
    }
  })
})
