import { AppError } from './errors.ts'
import { log } from './log.ts'

/** 本模块用到的 fetch 形状：URL、请求头与超时信号；测试可注入替身 */
export type FxFetch = (
  input: string,
  init: { headers: Record<string, string>; signal: object },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>

// 运行时由 Workers 与 Node 提供；源码不依赖 DOM 类型（同 log.ts），这里只声明本模块需要的形状
declare const fetch: FxFetch
declare const AbortSignal: { timeout(ms: number): object }

/**
 * 参考汇率（add-fx-rates）：以 USD 为基准的当地货币估价，供「约」值展示使用，不参与扣款。
 * 实际扣款以支付服务商（如 Stripe Adaptive Pricing）显示的金额为准。
 *
 * 数据源默认为 Exchange Rate API 的免费开放端点（无需密钥，约每日更新）。该服务要求在使用汇率的页面
 * 链接到其站点，见 {@link FX_ATTRIBUTION}。拉取失败时回退到调用方提供的固定参考值，并标记 `source`。
 *
 * 经 `@product-res/shared/fx` 单独导出：依赖 `log.ts`（`node:async_hooks`），不能进入浏览器包。
 */

export const FX_DEFAULT_URL = 'https://open.er-api.com/v6/latest/USD'

/** 服务商要求的署名：使用汇率的页面须显示此链接文字并指向该站点 */
export const FX_ATTRIBUTION = {
  text: 'Rates By Exchange Rate API',
  href: 'https://www.exchangerate-api.com',
} as const

/** 缓存时长：服务商每日更新一次，12 小时内复用同一份结果，避免频繁请求 */
export const FX_DEFAULT_TTL_SECONDS = 12 * 60 * 60

const CACHE_KEY = 'fx:usd:v1'

/** 键值缓存的最小接口；KV、Cache API 或内存实现均可满足 */
export interface FxStore {
  get(key: string): Promise<string | null>
  put(key: string, value: string, ttlSeconds: number): Promise<void>
}

export interface FxRates {
  readonly base: 'USD'
  /** 每 1 美元可兑换的货币数量，键为 ISO 4217 大写代码 */
  readonly rates: Readonly<Record<string, number>>
  /** `live` 为服务商数据（可能来自缓存），`fallback` 为调用方提供的参考值 */
  readonly source: 'live' | 'fallback'
  readonly fetchedAt: string
}

export interface FxOptions {
  readonly store: FxStore
  /** 拉取失败或响应无效时使用的参考值，键与 `rates` 相同 */
  readonly fallback: Readonly<Record<string, number>>
  readonly url?: string
  readonly fetch?: FxFetch
  readonly ttlSeconds?: number
  readonly now?: () => Date
  /** 拉取超时（毫秒），超时视为失败并回退 */
  readonly timeoutMs?: number
}

const CODE = /^[A-Z]{3}$/

/**
 * 校验开放端点的响应：`result` 必须为 `success`，`base_code` 必须为 USD，`rates` 中的每一项都是正的有限数。
 * 无效响应抛出 `AppError`，调用方据此回退，不把不完整的数据写入缓存。
 */
export function parseOpenErApiRates(body: unknown): Record<string, number> {
  const value = body as { result?: unknown; base_code?: unknown; rates?: unknown } | null
  if (!value || typeof value !== 'object' || value.result !== 'success')
    throw new AppError('FX_RATES_INVALID', 'FX response is not a success result')
  if (value.base_code !== 'USD')
    throw new AppError('FX_RATES_INVALID', 'FX response base is not USD')
  if (!value.rates || typeof value.rates !== 'object')
    throw new AppError('FX_RATES_INVALID', 'FX response has no rates')
  const rates: Record<string, number> = {}
  for (const [code, rate] of Object.entries(value.rates as Record<string, unknown>)) {
    if (!CODE.test(code) || typeof rate !== 'number' || !Number.isFinite(rate) || rate <= 0)
      throw new AppError('FX_RATES_INVALID', 'FX response contains an invalid rate')
    rates[code] = rate
  }
  return rates
}

/**
 * 取得以 USD 为基准的汇率：先读缓存，未命中则请求服务商并写入缓存；失败时回退到参考值。
 * 回退结果不写入缓存，下次调用会重新尝试拉取。
 */
export async function loadUsdRates(options: FxOptions): Promise<FxRates> {
  const now = options.now ?? (() => new Date())
  const ttl = options.ttlSeconds ?? FX_DEFAULT_TTL_SECONDS
  const cached = await readCache(options.store)
  if (cached) return cached

  try {
    const rates = await fetchRates(options)
    const result: FxRates = {
      base: 'USD',
      rates: { ...options.fallback, ...rates },
      source: 'live',
      fetchedAt: now().toISOString(),
    }
    await options.store.put(CACHE_KEY, JSON.stringify(result), ttl)
    return result
  } catch (error) {
    log.warn('fx.fallback', { error })
    return {
      base: 'USD',
      rates: { ...options.fallback },
      source: 'fallback',
      fetchedAt: now().toISOString(),
    }
  }
}

async function readCache(store: FxStore): Promise<FxRates | null> {
  try {
    const raw = await store.get(CACHE_KEY)
    if (!raw) return null
    const value = JSON.parse(raw) as FxRates
    return value.base === 'USD' && value.source === 'live' ? value : null
  } catch {
    // 缓存损坏或不可用时按未命中处理
    return null
  }
}

async function fetchRates(options: FxOptions): Promise<Record<string, number>> {
  const doFetch = options.fetch ?? fetch
  const timeoutMs = options.timeoutMs ?? 5000
  const response = await doFetch(options.url ?? FX_DEFAULT_URL, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!response.ok)
    throw new AppError('FX_RATES_UNAVAILABLE', `FX request failed: ${response.status}`)
  return parseOpenErApiRates(await response.json())
}
