import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { clientTemplateConfig, marketingPerformanceOptions } from './client-template-config.ts'

const FILE = '/repo/template.config.ts'
type LoadHook = (this: { environment: { name: string } }, id: string) => unknown

const load = (env: string, id: string, config: unknown = { app: { name: 'X' } }) =>
  (clientTemplateConfig(FILE, config).load as LoadHook).call({ environment: { name: env } }, id)

describe('客户端模板配置（构建期 JSON）', () => {
  it('client 环境把 template.config.ts 替换为解析后的 JSON，含查询参数时同样替换', () => {
    expect(load('client', FILE)).toBe('export default {"app":{"name":"X"}}')
    expect(load('client', `${FILE}?import`)).toBe('export default {"app":{"name":"X"}}')
  })

  it('服务端环境与其他文件不处理（服务端照常执行原文件与校验）', () => {
    expect(load('ssr', FILE)).toBeUndefined()
    expect(load('client', '/repo/other.ts')).toBeUndefined()
  })

  it('值为 undefined 的属性与省略等价', () => {
    expect(() => clientTemplateConfig(FILE, { a: { href: undefined, b: 1 } })).not.toThrow()
    expect(load('client', FILE, { a: { href: undefined, b: 1 } })).toBe(
      'export default {"a":{"b":1}}',
    )
  })

  it('配置不是纯数据时构建失败', () => {
    expect(() => clientTemplateConfig(FILE, { fn: () => 1 })).toThrow(/JSON-serialisable/)
    expect(() => clientTemplateConfig(FILE, { at: new Date(0) })).toThrow(/JSON-serialisable/)
  })
})

describe('marketing.performance 构建配置文件', () => {
  it('构建开始时写出，供构建后处理读取', () => {
    const dir = mkdtempSync(join(tmpdir(), 'perf-options-'))
    try {
      const file = join(dir, '.build/marketing-performance.json')
      const plugin = marketingPerformanceOptions(file, {
        hydration: 'after-paint',
        criticalCss: 'used',
        homeScriptGzipBudget: 1000,
      })
      expect(plugin.apply).toBe('build')
      ;(plugin.buildStart as () => void)()
      expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({
        hydration: 'after-paint',
        criticalCss: 'used',
        homeScriptGzipBudget: 1000,
        prerender: true,
      })
      // 营销页未启用时写出 prerender: false，构建后处理据此跳过
      const disabled = marketingPerformanceOptions(file, { criticalCss: 'used' }, false)
      ;(disabled.buildStart as () => void)()
      expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({
        criticalCss: 'used',
        prerender: false,
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
