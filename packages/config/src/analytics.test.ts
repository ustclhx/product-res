import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parsePlausibleSites, plausibleSite, resolvePlausibleSite } from './analytics.ts'

interface SitesCase {
  name: string
  raw: string
  sites?: Record<string, string>
  error?: boolean
  resolve?: [host: string, fallback: string, expected: string][]
}

// 与门禁脚本 scripts/production/production.test.mjs 读取同一份用例，两份解析实现不能各自漂移。
const { cases } = JSON.parse(
  readFileSync(new URL('./plausible-sites.cases.json', import.meta.url), 'utf8'),
) as { cases: SitesCase[] }

describe('PLAUSIBLE_SITES 解析（共享用例）', () => {
  for (const item of cases)
    it(item.name, () => {
      const parsed = parsePlausibleSites(item.raw)
      if (item.error) {
        expect(parsed).toHaveProperty('error')
        return
      }
      expect(parsed).toEqual({ sites: item.sites })
      const sites = 'sites' in parsed ? parsed.sites : {}
      for (const [host, fallback, expected] of item.resolve ?? [])
        expect(resolvePlausibleSite(sites, fallback, host)).toBe(expected)
    })
})

describe('plausibleSite 多站映射', () => {
  const env = { PLAUSIBLE_HOST: 'https://plausible.example/x' }

  it('有映射时给出映射与兜底，兜底可为空', () => {
    expect(
      plausibleSite('plausible', { ...env, PLAUSIBLE_SITES: 'a.example=a,b.example=b' }),
    ).toEqual({
      domain: '',
      sites: { 'a.example': 'a', 'b.example': 'b' },
      origin: 'https://plausible.example',
      scriptUrl: 'https://plausible.example/js/script.manual.js',
      eventUrl: 'https://plausible.example/api/event',
    })
  })

  it('单站与空映射输出不含 sites，与引入映射前一致', () => {
    for (const PLAUSIBLE_SITES of [undefined, '', '  '])
      expect(
        plausibleSite('plausible', { ...env, PLAUSIBLE_DOMAIN: 'acme', PLAUSIBLE_SITES }),
      ).toEqual({
        domain: 'acme',
        origin: 'https://plausible.example',
        scriptUrl: 'https://plausible.example/js/script.manual.js',
        eventUrl: 'https://plausible.example/api/event',
      })
  })

  it('映射格式错误、模板关闭或缺实例地址时不启用', () => {
    expect(
      plausibleSite('plausible', { ...env, PLAUSIBLE_DOMAIN: 'acme', PLAUSIBLE_SITES: 'bad' }),
    ).toBeNull()
    expect(plausibleSite('posthog', { ...env, PLAUSIBLE_SITES: 'a.example=a' })).toBeNull()
    expect(plausibleSite('plausible', { PLAUSIBLE_SITES: 'a.example=a' })).toBeNull()
  })
})
