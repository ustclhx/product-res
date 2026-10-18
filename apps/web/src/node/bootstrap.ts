import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { EnvValidationError } from '@product-res/config'
import { loadNodeEnv } from '@product-res/config/node'
import { log } from '@product-res/shared/log'
import templateConfig from '../../../../template.config.ts'
import { initializeNodeObservability } from './observability.ts'
import { bridgeNodeObserver } from './observer-context.ts'

// 该文件构建为 index.mjs；只在直接执行时读取部署配置。preview 导入保持无副作用。
const direct = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
let application: typeof import('./http.ts')
try {
  const config = direct ? loadNodeEnv({ templateConfig }) : undefined
  const observer = config
    ? await initializeNodeObservability({
        dsn: config.SENTRY_DSN,
        environment: config.SENTRY_ENVIRONMENT,
        release: __APP_VERSION__,
      })
    : undefined
  // Nitro/Start 与数据库/缓存模块必须在 SDK 初始化完成后才加载。
  const applicationPath = './application.mjs'
  application = await import(applicationPath)
  if (config && observer) await application.startNodeWeb(config, bridgeNodeObserver(observer))
} catch (error) {
  log.error(
    'node.web.start_failed',
    error instanceof EnvValidationError ? { fields: [...error.missing, ...error.invalid] } : {},
  )
  process.exit(1)
}
export const fetch = application.fetch
