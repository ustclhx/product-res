import { ConnectorError } from './errors.ts'
import type { FetchTask, NormalizedBatch, RawPayload, SourceConnector } from './types.ts'

export interface MockBehavior {
  /** 第 n 次 fetch（从 1 开始）抛出的错误类型 */
  readonly failOn?: Readonly<Record<number, 'retryable' | 'quota' | 'auth' | 'permanent'>>
  /** 归一化时缺失的指标，用于模拟字段缺失 */
  readonly missingMetrics?: readonly string[]
  readonly delayMs?: number
  /** 测试中区分多个模拟数据源 */
  readonly id?: string
  /** 每日硬上限，默认 100 */
  readonly hardCap?: number
  /** 响应中报告的外部剩余额度 */
  readonly remainingQuota?: number
}

/**
 * 模拟数据源：没有真实凭据时端到端验证框架（同步 → 存档 → 观测 → 预览）。
 * 只在测试与开发环境注册，生产默认不注册。
 */
export function createMockConnector(behavior: MockBehavior = {}): SourceConnector & {
  readonly calls: () => number
} {
  let calls = 0
  const id = behavior.id ?? 'mock'
  const hardCap = behavior.hardCap ?? 100
  return {
    id,
    label: '模拟数据源',
    access: 'api',
    marketplaces: ['ebay-us', 'amazon-us'],
    capabilities: ['product-snapshot', 'seller-new-listings'],
    budget: {
      unit: 'call',
      period: 'day',
      hardCap,
      safetyLine: Math.floor(hardCap * 0.9),
      timeZone: 'UTC',
    },
    secrets: [],
    queue: { concurrency: 2 },
    calls: () => calls,
    async probe(ctx) {
      return {
        sourceId: id,
        checkedAt: ctx.now().toISOString(),
        credentials: 'valid',
        checks: [
          { name: 'price', ok: true },
          {
            name: 'available_quantity',
            ok: !behavior.missingMetrics?.includes('available_quantity'),
          },
        ],
      }
    },
    plan: (task) => Math.max(1, Math.ceil(ids(task).length / 20)),
    async fetch(task, ctx) {
      calls += 1
      const failure = behavior.failOn?.[calls]
      if (failure) throw new ConnectorError(failure, `MOCK_${failure.toUpperCase()}`)
      if (behavior.delayMs) await new Promise((resolve) => setTimeout(resolve, behavior.delayMs))
      const items = ids(task).map((id, index) => ({
        id,
        title: `Mock item ${id}`,
        price: 9.99 + index,
        available: 100 - index,
      }))
      const payload: RawPayload = {
        sourceId: id,
        task,
        request: { method: 'GET', url: `https://mock.invalid/items?ids=${ids(task).join(',')}` },
        status: 200,
        body: JSON.stringify({ items }),
        fetchedAt: ctx.now().toISOString(),
        ...(behavior.remainingQuota === undefined
          ? {}
          : { remainingQuota: behavior.remainingQuota }),
      }
      return { payloads: [payload] }
    },
    normalize(payload): NormalizedBatch {
      const { items } = JSON.parse(payload.body) as {
        items: { id: string; title: string; price: number; available: number }[]
      }
      const observedOn = payload.fetchedAt.slice(0, 10)
      const marketplace = payload.task.marketplace
      return {
        entities: items.map((item) => ({
          key: { type: 'product', marketplace, platformId: item.id },
          facts: { title: item.title },
        })),
        observations: items.flatMap((item) => {
          const entity = { type: 'product', marketplace, platformId: item.id } as const
          const rows = [
            {
              entity,
              metric: 'price',
              observedOn,
              value: item.price,
              currency: 'USD',
              method: 'official' as const,
            },
            {
              entity,
              metric: 'available_quantity',
              observedOn,
              value: item.available,
              method: 'official' as const,
            },
          ]
          return rows.filter((row) => !behavior.missingMetrics?.includes(row.metric))
        }),
      }
    },
  }
}

function ids(task: FetchTask): string[] {
  const value = task.scope.ids
  return Array.isArray(value) ? value.map(String) : []
}
