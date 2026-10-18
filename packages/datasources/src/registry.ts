import type { DataKind, Marketplace, SourceConnector } from './types.ts'

/** 数据源注册表：按能力派发同步任务，只派给已启用且声明了该能力的数据源 */
export function createRegistry(connectors: readonly SourceConnector[]) {
  const byId = new Map<string, SourceConnector>()
  for (const connector of connectors) {
    if (byId.has(connector.id)) throw new Error(`Duplicate data source ${connector.id}`)
    byId.set(connector.id, connector)
  }
  return {
    all: () => [...byId.values()],
    get: (id: string) => byId.get(id),
    /** 声明了该数据类型与站点、且在启用集合内的数据源 */
    providers(kind: DataKind, marketplace: Marketplace, enabled: ReadonlySet<string>) {
      return [...byId.values()].filter(
        (c) =>
          enabled.has(c.id) &&
          c.access === 'api' &&
          c.capabilities.includes(kind) &&
          c.marketplaces.includes(marketplace),
      )
    },
  }
}

export type SourceRegistry = ReturnType<typeof createRegistry>
