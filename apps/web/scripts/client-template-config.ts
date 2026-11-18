import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { normalizePath, type Plugin } from 'vite'

/**
 * 客户端模板配置：浏览器端不需要在运行时用 zod 解析 template.config.ts。构建与 dev 时在 Node 中
 * 已得到解析后的配置（vite-shared 导入同一文件），这里把客户端环境对该文件的加载替换为同值的 JSON，
 * 使 zod 与 @product-res/config 的校验代码不进入客户端入口（营销页首屏关键路径）。服务端环境照常执行原文件。
 */
export function clientTemplateConfig(configFile: string, resolved: unknown): Plugin {
  const json = JSON.stringify(resolved)
  // 模板配置只应是数据；含函数、Date 等时 JSON 会丢失信息，宁可构建失败（值为 undefined 的属性与省略等价，不算）
  if (!isDeepStrictEqual(JSON.parse(json), withoutUndefined(resolved)))
    throw new Error('template.config.ts must resolve to JSON-serialisable data')
  // Vite 的模块 id 总是正斜杠；Windows 上 fileURLToPath 给出反斜杠
  const target = normalizePath(configFile)
  return {
    name: 'saas:client-template-config',
    enforce: 'pre',
    load(id) {
      if (this.environment.name !== 'client') return
      if (normalizePath(id.split('?')[0] ?? '') !== target) return
      return `export default ${json}`
    },
  }
}

/** 去掉值为 undefined 的对象属性（与 JSON 序列化一致），其余原样保留以便比较 */
function withoutUndefined(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutUndefined)
  if (
    value === null ||
    typeof value !== 'object' ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    return value
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .map(([key, item]) => [key, withoutUndefined(item)]),
  )
}

/**
 * 构建时把 `marketing.performance` 写到 dist/.build/marketing-performance.json，
 * 供构建后处理 scripts/inline-critical-css.mjs 读取（不在 dist/client，不会被公开）。
 */
export function marketingPerformanceOptions(file: string, performance: unknown): Plugin {
  return {
    name: 'saas:marketing-performance-options',
    apply: 'build',
    buildStart() {
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, `${JSON.stringify(performance, null, 2)}\n`)
    },
  }
}
