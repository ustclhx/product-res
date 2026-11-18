import { describe, expect, it } from 'vitest'
import { AppError } from './errors.ts'
import {
  FX_ATTRIBUTION,
  type FxFetch,
  type FxStore,
  loadUsdRates,
  parseOpenErApiRates,
} from './fx.ts'

function memoryStore(initial: string | null = null): FxStore & { values: Map<string, string> } {
  const values = new Map<string, string>()
  if (initial) values.set('fx:usd:v1', initial)
  return {
    values,
    get: async (key) => values.get(key) ?? null,
    put: async (key, value) => void values.set(key, value),
  }
}

const body = { result: 'success', base_code: 'USD', rates: { USD: 1, CNY: 7.1, KRW: 1400 } }
const fallback = { CNY: 7.2, KRW: 1350, TWD: 32.5 }
const now = () => new Date('2026-10-22T00:00:00.000Z')

function jsonFetch(payload: unknown, status = 200) {
  return (async () => new Response(JSON.stringify(payload), { status })) as FxFetch
}

describe('parseOpenErApiRates', () => {
  it('接受成功响应并返回汇率表', () => {
    expect(parseOpenErApiRates(body)).toEqual({ USD: 1, CNY: 7.1, KRW: 1400 })
  })

  it.each([
    ['非 success 结果', { ...body, result: 'error' }],
    ['基准不是 USD', { ...body, base_code: 'EUR' }],
    ['缺少 rates', { result: 'success', base_code: 'USD' }],
    ['汇率不是正数', { ...body, rates: { CNY: 0 } }],
    ['汇率不是有限数', { ...body, rates: { CNY: Number.NaN } }],
    ['货币代码不合法', { ...body, rates: { cny: 7 } }],
    ['空响应', null],
  ])('%s 视为无效', (_, input) => {
    expect(() => parseOpenErApiRates(input)).toThrow(AppError)
  })
})

describe('loadUsdRates', () => {
  it('拉取成功时写入缓存，并与参考值合并（服务商缺失的货币用参考值）', async () => {
    const store = memoryStore()
    const result = await loadUsdRates({ store, fallback, fetch: jsonFetch(body), now })
    expect(result).toEqual({
      base: 'USD',
      rates: { CNY: 7.1, KRW: 1400, TWD: 32.5, USD: 1 },
      source: 'live',
      fetchedAt: '2026-10-22T00:00:00.000Z',
    })
    expect(store.values.has('fx:usd:v1')).toBe(true)
  })

  it('缓存命中时不再请求服务商', async () => {
    const store = memoryStore()
    await loadUsdRates({ store, fallback, fetch: jsonFetch(body), now })
    let calls = 0
    const counting = (async () => {
      calls += 1
      return new Response('{}')
    }) as FxFetch
    const again = await loadUsdRates({ store, fallback, fetch: counting, now })
    expect(calls).toBe(0)
    expect(again.source).toBe('live')
  })

  it('请求失败、响应无效或超时时回退到参考值，且不写入缓存', async () => {
    for (const failing of [
      jsonFetch({ result: 'error' }),
      jsonFetch(body, 503),
      (async () => {
        throw new TypeError('network down')
      }) as FxFetch,
    ]) {
      const store = memoryStore()
      const result = await loadUsdRates({ store, fallback, fetch: failing, now })
      expect(result).toEqual({
        base: 'USD',
        rates: { ...fallback },
        source: 'fallback',
        fetchedAt: '2026-10-22T00:00:00.000Z',
      })
      expect(store.values.size).toBe(0)
    }
  })

  it('损坏的缓存按未命中处理', async () => {
    const store = memoryStore('{not json')
    const result = await loadUsdRates({ store, fallback, fetch: jsonFetch(body), now })
    expect(result.source).toBe('live')
  })

  it('署名常量指向服务商站点', () => {
    expect(FX_ATTRIBUTION.href).toBe('https://www.exchangerate-api.com')
  })
})
