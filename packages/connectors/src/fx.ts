import {
  type ConnectorContext,
  ConnectorError,
  type FetchTask,
  httpRequest,
  type NormalizedBatch,
  parseCsv,
  type RawPayload,
  type SourceConnector,
} from '@product-res/datasources'

/** 欧洲央行参考汇率（EUR 基准），换算为 {币种}/CNY；工作日更新 */
const CURRENCIES = ['USD', 'EUR', 'GBP', 'JPY'] as const
const ECB_URL =
  'https://data-api.ecb.europa.eu/service/data/EXR/D.CNY+USD+GBP+JPY.EUR.SP00.A?lastNObservations=5&format=csvdata'

/**
 * 汇率连接器（add-source-connectors design D8）：公开来源，无凭据。
 * 观测实体为币种对（如 USD/CNY），指标 fx_rate，日期为 ECB 的观测日期。
 */
export function createFxConnector(): SourceConnector {
  return {
    id: 'fx-ecb',
    label: '汇率（欧洲央行）',
    access: 'api',
    marketplaces: ['global'],
    capabilities: ['fx-rate'],
    budget: { unit: 'call', period: 'day', hardCap: 50, safetyLine: 40, timeZone: 'UTC' },
    secrets: [],
    queue: { concurrency: 1 },
    async probe(ctx) {
      const checkedAt = ctx.now().toISOString()
      try {
        const payload = await fetchRates(ctx, { kind: 'fx-rate', marketplace: 'global', scope: {} })
        const batch = normalizeRates(payload)
        return {
          sourceId: 'fx-ecb',
          checkedAt,
          credentials: 'valid',
          checks: CURRENCIES.map((c) => ({
            name: `${c}/CNY`,
            ok: batch.observations.some((o) => o.entity.platformId === `${c}/CNY`),
          })),
        }
      } catch (error) {
        return {
          sourceId: 'fx-ecb',
          checkedAt,
          credentials: 'valid',
          checks: [
            {
              name: 'reachable',
              ok: false,
              detail: error instanceof ConnectorError ? error.code : 'ERROR',
            },
          ],
        }
      }
    },
    plan: () => 1,
    async fetch(task, ctx) {
      return { payloads: [await fetchRates(ctx, task)] }
    },
    normalize: normalizeRates,
  }
}

async function fetchRates(ctx: ConnectorContext, task: FetchTask): Promise<RawPayload> {
  const res = await httpRequest(ctx.fetch, { url: ECB_URL, headers: { accept: 'text/csv' } })
  return {
    sourceId: 'fx-ecb',
    task,
    request: res.request,
    status: res.status,
    body: res.body,
    fetchedAt: ctx.now().toISOString(),
  }
}

/** ECB CSV：每行一个币种一天，OBS_VALUE = 1 EUR 兑换的该币种数量 */
export function normalizeRates(payload: RawPayload): NormalizedBatch {
  const [header, ...rows] = parseCsv(payload.body)
  if (!header) throw new ConnectorError('invalid-response', 'FX_EMPTY')
  const col = (name: string) => header.indexOf(name)
  const [cur, day, value] = [col('CURRENCY'), col('TIME_PERIOD'), col('OBS_VALUE')]
  if (cur < 0 || day < 0 || value < 0) throw new ConnectorError('invalid-response', 'FX_COLUMNS')
  // 按日期聚合：date → currency → 每 EUR 数量
  const byDay = new Map<string, Map<string, number>>()
  for (const row of rows) {
    const rate = Number(row[value])
    if (!row[cur] || !row[day] || !Number.isFinite(rate) || rate <= 0) continue
    const map = byDay.get(row[day] as string) ?? new Map<string, number>()
    map.set(row[cur] as string, rate)
    byDay.set(row[day] as string, map)
  }
  const observations: NormalizedBatch['observations'][number][] = []
  const entities = new Map<string, NormalizedBatch['entities'][number]>()
  for (const [observedOn, rates] of byDay) {
    const cnyPerEur = rates.get('CNY')
    if (!cnyPerEur) continue
    for (const currency of CURRENCIES) {
      const perEur = currency === 'EUR' ? 1 : rates.get(currency)
      if (!perEur) continue
      const entity = {
        type: 'currency' as const,
        marketplace: 'global' as const,
        platformId: `${currency}/CNY`,
      }
      entities.set(entity.platformId, { key: entity })
      observations.push({
        entity,
        metric: 'fx_rate',
        observedOn,
        value: Math.round((cnyPerEur / perEur) * 1e6) / 1e6,
        method: 'official',
      })
    }
  }
  return { entities: [...entities.values()], observations }
}
