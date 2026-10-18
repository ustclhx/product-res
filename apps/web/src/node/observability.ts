import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { AppError } from '@product-res/shared'
import { getLogContext, log, sentryBeforeSend } from '@product-res/shared/log'
import type { ErrorEvent, EventHint, NodeOptions, StackFrame } from '@sentry/node'
import { isNotFound, isRedirect } from '@tanstack/react-router'

export interface NodeObservabilityConfig {
  dsn?: string | undefined
  environment?: 'development' | 'staging' | 'production' | 'smoke' | undefined
  release: string
}

const identityKeys = ['requestId', 'workspaceId', 'userId', 'jobId', 'taskId', 'scheduleId', 'cron']
const errorTypes = new Set([
  'Error',
  'TypeError',
  'RangeError',
  'SyntaxError',
  'AppError',
  'AggregateError',
])

function ignored(error: unknown): boolean {
  return isRedirect(error) || isNotFound(error) || (error instanceof AppError && error.status < 500)
}

function safeCode(error: unknown): string {
  return error instanceof AppError && /^[A-Z][A-Z0-9_]{0,63}$/.test(error.code)
    ? error.code
    : 'INTERNAL_ERROR'
}

function identityTags(source: Record<string, unknown>): Record<string, string> {
  return Object.fromEntries(
    identityKeys.flatMap((key) => {
      const value = source[key]
      return typeof value === 'string' ? [[key, value]] : []
    }),
  )
}

function sourceFrame(frame: StackFrame): StackFrame | undefined {
  const filename = frame.filename
  // 异常可伪造 stack：只保留实际应用文件位置，不采集函数原文、源码行或局部变量。
  if (!filename || /[?#\n\r]/.test(filename) || !/\.(?:[cm]?js|tsx?)$/.test(filename)) return
  if (filename.includes('://') && !filename.startsWith('file://')) return
  let path: string
  try {
    path = filename.startsWith('file://') ? fileURLToPath(filename) : resolve(filename)
  } catch {
    return
  }
  if (!existsSync(path)) return
  return {
    filename,
    ...(frame.lineno === undefined ? {} : { lineno: frame.lineno }),
    ...(frame.colno === undefined ? {} : { colno: frame.colno }),
    ...(frame.in_app === undefined ? {} : { in_app: frame.in_app }),
  }
}

/** 先走既有脱敏，再以白名单重建 envelope；任意异常文本无法可靠区分正文与安全消息。 */
export function nodeBeforeSend(event: ErrorEvent, hint: EventHint): ErrorEvent | null {
  if (ignored(hint.originalException)) return null
  const redacted = sentryBeforeSend(event)
  const tags = identityTags(hint.data?.nodeIdentity ?? getLogContext())
  // 附件不属于安全错误契约，也不能从父级 scope 带出正文。
  hint.attachments = []
  const code = safeCode(hint.originalException)
  const values = redacted.exception?.values?.map((exception) => ({
    type: errorTypes.has(exception.type ?? '') ? (exception.type ?? 'Error') : 'Error',
    value: code,
    ...(exception.stacktrace
      ? {
          stacktrace: {
            frames: exception.stacktrace.frames?.flatMap((frame) => sourceFrame(frame) ?? []) ?? [],
          },
        }
      : {}),
    ...(exception.mechanism
      ? { mechanism: { type: 'generic', handled: exception.mechanism.handled ?? true } }
      : {}),
  }))
  return {
    type: undefined,
    ...(redacted.event_id === undefined ? {} : { event_id: redacted.event_id }),
    ...(redacted.timestamp === undefined ? {} : { timestamp: redacted.timestamp }),
    platform: 'node',
    ...(redacted.level === undefined ? {} : { level: redacted.level }),
    ...(redacted.release === undefined ? {} : { release: redacted.release }),
    ...(redacted.environment === undefined ? {} : { environment: redacted.environment }),
    ...(redacted.dist === undefined ? {} : { dist: redacted.dist }),
    tags: { ...tags, code },
    ...(tags.userId ? { user: { id: tags.userId } } : {}),
    exception: { values: values ?? [] },
    // SDK 在 beforeSend 前把注入的 debug ID 转为 images；只保留已验证的本地源码路径与 UUID。
    debug_meta: {
      images:
        redacted.debug_meta?.images?.flatMap((entry) => {
          if (
            entry.type !== 'sourcemap' ||
            typeof entry.code_file !== 'string' ||
            typeof entry.debug_id !== 'string' ||
            !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(entry.debug_id) ||
            !sourceFrame({ filename: entry.code_file })
          )
            return []
          return [
            { type: 'sourcemap' as const, code_file: entry.code_file, debug_id: entry.debug_id },
          ]
        }) ?? [],
    },
  }
}

/** 仅由早期 Node ESM composition 调用一次；导入本文件与禁用路径均不会加载 SDK。 */
export async function initializeNodeObservability(
  config: NodeObservabilityConfig,
  transport?: NodeOptions['transport'],
) {
  const enabled = Boolean(
    config.dsn && ['staging', 'production', 'smoke'].includes(config.environment ?? ''),
  )
  const seen = new WeakSet<object>()
  const sdk = enabled ? await import('@sentry/node') : undefined
  const client = sdk?.init({
    dsn: config.dsn,
    environment: config.environment,
    release: config.release,
    dist: 'web-node',
    debug: false,
    spotlight: false,
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: false,
      httpBodies: [],
      urlQueryParams: false,
      graphQL: { document: false, variables: false },
      genAI: { inputs: false, outputs: false },
      databaseQueryData: false,
      queues: false,
      stackFrameVariables: false,
      frameContextLines: 0,
    },
    includeServerName: false,
    includeLocalVariables: false,
    beforeSendLog: () => null,
    beforeSendMetric: () => null,
    beforeSendTransaction: () => null,
    sendClientReports: false,
    tracesSampleRate: 0,
    traceLifecycle: 'static',
    enableOpenTelemetrySetup: false,
    enableRuntimeChannelInjection: false,
    defaultIntegrations: false,
    integrations: [
      {
        name: 'NodeUncaughtException',
        setup(fatalClient) {
          let stopping = false
          const handle = (error: Error) => {
            if (sdk.getClient() !== fatalClient) return
            fatalClient.captureException(
              error,
              {
                originalException: error,
                mechanism: { handled: false, type: 'auto.node.uncaughtException' },
              },
              sdk.getCurrentScope(),
            )
            log.error('node.unhandled', { code: safeCode(error) })
            // 不安装 rejection 监听器，已有 uncaught 处理器继续拥有退出策略。
            if (process.listeners('uncaughtException').some((listener) => listener !== handle))
              return
            // SDK 默认 integration 二次 fatal 会打印原文；这里直接安全退出。
            if (stopping) process.exit(1)
            stopping = true
            const deadline = setTimeout(() => process.exit(1), 2_000)
            deadline.unref()
            void Promise.resolve(fatalClient.flush(2_000)).then(
              () => process.exit(1),
              () => process.exit(1),
            )
          }
          process.on('uncaughtException', handle)
          fatalClient.on('close', () => process.off('uncaughtException', handle))
        },
      },
    ],
    beforeSend: nodeBeforeSend,
    ...(transport ? { transport } : {}),
  })
  function run<T>(handle: () => T): T {
    if (!sdk || !client) return handle()
    return sdk.withIsolationScope(new sdk.Scope(), () =>
      sdk.withScope(new sdk.Scope(), (scope) => {
        scope.setClient(client)
        return handle()
      }),
    )
  }
  function captureError(error: unknown): void {
    if (ignored(error)) return
    if (typeof error === 'object' && error !== null) {
      if (seen.has(error)) return
      seen.add(error)
    }
    log.error('http.server_error', { code: safeCode(error) })
    if (!sdk || !client) return
    // 每次采集独立快照，兼容鉴权后补充身份及异步处理，绝不写全局 scope。
    run(() => {
      const scope = sdk.getCurrentScope()
      const tags = identityTags(getLogContext())
      scope.setTags(tags)
      if (tags.userId) scope.setUser({ id: tags.userId })
      client.captureException(
        error,
        { originalException: error, data: { nodeIdentity: tags } },
        scope,
      )
    })
  }
  return { enabled, captureError, run, client }
}
