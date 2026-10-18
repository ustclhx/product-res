import { createMockConnector, createRegistry, type SourceConnector } from '@product-res/datasources'

/**
 * web 侧的数据源注册表：与 apps/jobs 使用同一组连接器（add-source-connectors 加入真实连接器后
 * 统一放到共享 package）。模拟数据源只在 DATASOURCE_MOCK=true 时注册。
 */
let registry: ReturnType<typeof createRegistry> | undefined
let secrets: ((name: string) => string | undefined) | undefined

const env = () =>
  (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {}

export function webConnectors(): ReturnType<typeof createRegistry> {
  if (!registry) {
    const connectors: SourceConnector[] = []
    if (env().DATASOURCE_MOCK === 'true') connectors.push(createMockConnector())
    registry = createRegistry(connectors)
  }
  return registry
}

/** 读取数据源凭据（只在 Node 目标可用）；页面只用于显示“已配置 / 未配置” */
export async function webSecrets() {
  if (!secrets) {
    const { createDataSourceSecrets } = await import('@product-res/config/node')
    secrets = createDataSourceSecrets(env())
  }
  return secrets
}
