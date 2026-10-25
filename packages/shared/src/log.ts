/// <reference path="./async-hooks.d.ts" />
/**
 * 请求 ID 与结构化日志（design 决策 2，specs/observability「结构化日志」），经 `@product-res/shared/log` 单独导出：
 * 依赖 `node:async_hooks`，不能进入浏览器包。
 *
 * - 入口（web 的 fetch、jobs 的 queue / scheduled / Workflow）用 `withLogContext` 建立上下文，
 *   同一调用链中的日志自动带上请求 ID 等字段；拿到空间与用户后用 `setLogContext` 补充。
 * - 投递队列消息、启动 Workflow 时用 `withRequestId` 带上当前请求 ID；消费端从消息中恢复。
 * - 日志一行一个 JSON 对象，输出前经 `redact` 脱敏。
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import { newId } from './id.ts'
import { redact, redactUrl } from './redact.ts'

export { isSensitiveKey, REDACTED, redact, redactUrl, redactUrlPath } from './redact.ts'

export interface LogContext {
  readonly requestId?: string
  readonly workspaceId?: string
  readonly userId?: string
  readonly [field: string]: unknown
}

export type LogLevel = 'info' | 'warn' | 'error'
export type LogFields = Readonly<Record<string, unknown>>

// 本包不引入 DOM / Workers 的全局类型，只声明用到的 console 方法
declare const console: {
  log(line: string): void
  warn(line: string): void
  error(line: string): void
}

const storage = new AsyncLocalStorage<Record<string, unknown>>()

/** 请求 ID：UUIDv7（时间有序，便于按时间检索） */
export function newRequestId(): string {
  return newId()
}

/** 在当前上下文的基础上合并 `fields`（值为 undefined 的字段忽略）后执行 `fn` */
export function withLogContext<R>(fields: LogContext, fn: () => R): R {
  return storage.run({ ...storage.getStore(), ...defined(fields) }, fn)
}

/** 向当前上下文补充字段（如鉴权后得到的 workspaceId / userId）；不在上下文中时忽略 */
export function setLogContext(fields: LogContext): void {
  const store = storage.getStore()
  if (store) Object.assign(store, defined(fields))
}

export function getLogContext(): LogContext {
  return { ...storage.getStore() }
}

/** Sentry 的 beforeSend：复用统一脱敏，只保留定位所需的身份 ID，不采集请求正文与面包屑。 */
export function sentryBeforeSend<T extends object>(event: T): T {
  const value = event as Record<string, unknown>
  const { requestId, workspaceId, userId } = getLogContext()
  const request = value.request as Record<string, unknown> | undefined
  const user = value.user as { id?: string } | undefined
  return redact({
    ...value,
    breadcrumbs: undefined,
    user: userId || user?.id ? { id: userId ?? user?.id } : undefined,
    request: request
      ? {
          method: request.method,
          url:
            typeof request.url === 'string'
              ? redactUrl(request.url.split(/[?#]/)[0] ?? '')
              : undefined,
          headers: request.headers,
        }
      : undefined,
    tags: {
      ...(value.tags as object),
      ...Object.fromEntries(
        Object.entries({ requestId, workspaceId, userId }).filter(
          ([, value]) => value !== undefined,
        ),
      ),
    },
  }) as T
}

export function currentRequestId(): string | undefined {
  const requestId = storage.getStore()?.requestId
  return typeof requestId === 'string' ? requestId : undefined
}

/** 给队列消息 / Workflow 参数带上当前请求 ID；不在请求上下文中时原样返回 */
export function withRequestId<T extends object>(message: T): T & { requestId?: string } {
  const requestId = currentRequestId()
  return requestId === undefined ? message : { ...message, requestId }
}

/**
 * 输出一行结构化日志：`{ level, event, ...上下文, ...fields }`，经脱敏后序列化。
 * `error` 字段可以直接传入捕获到的异常，输出时只保留 name / message / stack。写日志本身不会抛错。
 */
export function writeLog(level: LogLevel, event: string, fields: LogFields = {}): void {
  let line: string
  try {
    line = JSON.stringify(redact({ level, event, ...storage.getStore(), ...fields }))
  } catch {
    // 日志永远不影响业务流程：字段无法序列化（如 getter 抛错）时只记录事件名
    line = JSON.stringify({
      level,
      event,
      ...(redact(storage.getStore() ?? {}) as LogFields),
      logError: true,
    })
  }
  if (level === 'error') console.error(line)
  else if (level === 'warn') console.warn(line)
  else console.log(line)
}

export const log = {
  info: (event: string, fields?: LogFields) => writeLog('info', event, fields),
  warn: (event: string, fields?: LogFields) => writeLog('warn', event, fields),
  error: (event: string, fields?: LogFields) => writeLog('error', event, fields),
}

function defined(fields: LogContext): Record<string, unknown> {
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined))
}
