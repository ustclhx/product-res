import { describe, expect, it } from 'vitest'
import { getWebRuntime, type WebRuntime, withWebRuntime } from './runtime.ts'

const runtime = (clientIp: string) =>
  ({
    requestMeta: { clientIp, requestId: clientIp },
  }) as WebRuntime

describe('request runtime isolation', () => {
  it('keeps trusted metadata isolated across concurrent asynchronous requests', async () => {
    let resume: () => void = () => {}
    const paused = new Promise<void>((resolve) => {
      resume = resolve
    })
    const first = withWebRuntime(runtime('198.51.100.1'), async () => {
      await paused
      return getWebRuntime().requestMeta.clientIp
    })
    const second = withWebRuntime(runtime('198.51.100.2'), async () => {
      await Promise.resolve()
      const ip = getWebRuntime().requestMeta.clientIp
      resume()
      return ip
    })
    expect(await Promise.all([first, second])).toEqual(['198.51.100.1', '198.51.100.2'])
  })

  it('rejects access outside a request instead of reusing another request resources', () => {
    withWebRuntime(runtime('198.51.100.1'), () => expect(getWebRuntime()).toBeDefined())
    expect(getWebRuntime).toThrow(
      expect.objectContaining({ code: 'RUNTIME_UNAVAILABLE', status: 503 }),
    )
  })
})
