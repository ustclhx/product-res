import {
  ConnectorError,
  type DataKind,
  type Marketplace,
  type SourceConnector,
} from '@product-res/datasources'

/**
 * 只能文件导入的数据源描述（specs/connector-helium10）：在注册表登记来源、站点与能力，
 * 让数据中心显示“文件导入”类型卡片；没有网络实现，也不参与任何定时同步（registry.providers 只派发 api 类型）。
 */
export function createFileImportSource(options: {
  id: string
  label: string
  marketplaces: readonly Marketplace[]
  capabilities: readonly DataKind[]
}): SourceConnector {
  return {
    ...options,
    access: 'file',
    // 额度不适用；占位值不会被读取（数据中心对文件类型不显示额度）
    budget: { unit: 'call', period: 'day', hardCap: 0, safetyLine: 0, timeZone: 'UTC' },
    secrets: [],
    queue: { concurrency: 1 },
    async probe(ctx) {
      return {
        sourceId: options.id,
        checkedAt: ctx.now().toISOString(),
        credentials: 'valid',
        checks: [],
      }
    },
    plan: () => 0,
    async fetch() {
      throw new ConnectorError('permanent', 'FILE_IMPORT_ONLY')
    },
    normalize: () => ({ entities: [], observations: [] }),
  }
}

/** Helium 10：Black Box / Xray / Cerebro / Magnet 导出文件；Enterprise API 待官方确认 */
export const createHelium10Source = () =>
  createFileImportSource({
    id: 'helium10',
    label: 'Helium 10（导出文件）',
    marketplaces: ['amazon-us', 'amazon-uk', 'amazon-de', 'amazon-jp', 'amazon-ca'],
    capabilities: ['sales-estimate', 'keyword-volume', 'product-snapshot'],
  })
