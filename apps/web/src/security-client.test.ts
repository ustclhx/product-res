import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('security-client', () => {
  it('不 import zod 也能让 zod 读到 jitless（zod 升级改了全局配置位置时此处失败）', async () => {
    await import('./security-client')
    const { config, z } = await import('zod')
    expect(config().jitless).toBe(true)
    expect(config()).toBe((globalThis as { __zod_globalConfig?: object }).__zod_globalConfig)
    expect(z.object({ a: z.string() }).parse({ a: 'x' })).toEqual({ a: 'x' })
  })

  it('源码不 import zod，避免首页静态依赖整套 zod', () => {
    const source = readFileSync(new URL('./security-client.ts', import.meta.url), 'utf8')
    expect(source).not.toMatch(/from\s+['"]zod/)
  })
})
