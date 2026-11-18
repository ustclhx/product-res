import { templateConfig } from '../../server/template-config.ts'
import type { RegisteredShareCard, ShareCardDefinition } from './types.ts'

export const defaultShareTokenPattern = /^[A-Za-z0-9_-]{22,64}$/
const registry = new Map<string, RegisteredShareCard<unknown>>()

/**
 * 开发服务器热更新会重新执行注册入口，而注册表模块保留旧条目；此时以新定义替换旧定义。
 * 生产构建与测试中 DEV 为 false 或 MODE 为 test，重名仍然报错。
 */
function replacesOnReload(): boolean {
  const env = import.meta.env as { DEV?: boolean; MODE?: string } | undefined
  return Boolean(import.meta.hot) || (env?.DEV === true && env.MODE !== 'test')
}

export function registerShareCard<T>(definition: ShareCardDefinition<T>): RegisteredShareCard<T> {
  if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(definition.type)) {
    throw new TypeError('Share card type must use lowercase letters, numbers and hyphens')
  }
  if (registry.has(definition.type) && !replacesOnReload()) {
    throw new Error(`Share card type already registered: ${definition.type}`)
  }
  const ttlDays =
    definition.ttlDays === undefined ? templateConfig.shareCards.defaultTtlDays : definition.ttlDays
  if (ttlDays !== null && (!Number.isInteger(ttlDays) || ttlDays <= 0)) {
    throw new RangeError('Share card ttlDays must be a positive integer or null')
  }
  const registered: RegisteredShareCard<T> = {
    ...definition,
    tokenPattern: definition.tokenPattern ?? defaultShareTokenPattern,
    ttlDays,
    sharePage: definition.sharePage !== false,
  }
  // 注册表擦除各业务数据类型；调用方须把同一定义 resolve 的数据交回该定义。
  registry.set(definition.type, registered as RegisteredShareCard<unknown>)
  return registered
}

export function getShareCard(type: string): RegisteredShareCard<unknown> | undefined {
  return registry.get(type)
}
