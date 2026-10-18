import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { compile } from '@inlang/paraglide-js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  activeLocales,
  findMissingMessages,
  formatMissingMessages,
  paraglideOptions,
  writeInlangProject,
} from './i18n-project.ts'

const i18n = { locales: ['en', 'zh'], defaultLocale: 'en' }
let root: string

function writeMessages(locale: string, feature: string, messages: Record<string, string>) {
  mkdirSync(join(root, 'messages', locale), { recursive: true })
  writeFileSync(join(root, 'messages', locale, `${feature}.json`), JSON.stringify(messages))
}

// 临时的 apps/web 结构：中文 common.json 删掉了一条文案
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'product-res-i18n-'))
  symlinkSync(new URL('../node_modules', import.meta.url).pathname, join(root, 'node_modules'))
  writeMessages('en', 'common', { common_save: 'Save', common_cancel: 'Cancel' })
  writeMessages('zh', 'common', { common_save: '保存' })
  writeMessages('en', 'pricing', { pricing_title: 'Pricing' })
  writeMessages('zh', 'pricing', { pricing_title: '定价' })
})

afterAll(() => rmSync(root, { recursive: true, force: true }))

describe('文案回退与缺失检查（tasks.md 1.3）', () => {
  it('缺失检查以默认语言为准列出缺失项', () => {
    const missing = findMissingMessages(i18n, root)
    expect(missing).toEqual([{ locale: 'zh', feature: 'common', key: 'common_cancel' }])
    expect(formatMissingMessages(missing)).toContain('zh: common_cancel (messages/zh/common.json)')
    expect(formatMissingMessages([])).toBeNull()
  })

  it('按功能拆分的文案文件编译后，缺失的中文文案回退到默认语言文本而不是键名', async () => {
    writeInlangProject(i18n, root)
    await compile({ ...paraglideOptions([], root), emitTsDeclarations: false })
    const { m } = (await import(join(root, 'src/paraglide/messages.js'))) as {
      m: Record<string, (inputs?: object, options?: { locale: string }) => string>
    }
    expect(m.common_save?.({}, { locale: 'zh' })).toBe('保存')
    expect(m.pricing_title?.({}, { locale: 'zh' })).toBe('定价')
    expect(m.common_cancel?.({}, { locale: 'zh' })).toBe('Cancel')
  })
})

it('关闭 i18n 后真实编译仅保留默认中文，账号 Cookie 和语言 URL 不改变语言', async () => {
  const singleRoot = mkdtempSync(join(tmpdir(), 'product-res-i18n-single-'))
  try {
    symlinkSync(
      new URL('../node_modules', import.meta.url).pathname,
      join(singleRoot, 'node_modules'),
    )
    for (const [locale, text] of [
      ['en', 'Save'],
      ['zh', '保存'],
    ] as const) {
      mkdirSync(join(singleRoot, 'messages', locale), { recursive: true })
      writeFileSync(
        join(singleRoot, 'messages', locale, 'common.json'),
        JSON.stringify({ common_save: text }),
      )
    }
    const single = { ...i18n, enabled: false, defaultLocale: 'zh' }
    expect(activeLocales(single)).toEqual(['zh'])
    expect(activeLocales(i18n)).toEqual(['en', 'zh'])
    writeInlangProject(single, singleRoot)
    const options = paraglideOptions(['/app', '/account'], singleRoot, false)
    expect(options.strategy).toEqual(['baseLocale'])
    expect(options.routeStrategies ?? []).toEqual([])
    await compile({ ...options, emitTsDeclarations: false })
    const runtime = await import(join(singleRoot, 'src/paraglide/runtime.js'))
    const { m } = await import(join(singleRoot, 'src/paraglide/messages.js'))
    const { paraglideMiddleware } = await import(join(singleRoot, 'src/paraglide/server.js'))
    expect(runtime.locales).toEqual(['zh'])
    expect(runtime.baseLocale).toBe('zh')
    expect(m.common_save()).toBe('保存')
    for (const path of ['/app', '/en/pricing', '/zh/pricing']) {
      const response = await paraglideMiddleware(
        new Request(`https://product.ezarouter.cc${path}`, {
          headers: { cookie: 'PARAGLIDE_LOCALE=en' },
        }),
        () => new Response(runtime.getLocale()),
      )
      expect(await response.text()).toBe('zh')
      expect(response.headers.get('location')).toBeNull()
    }
  } finally {
    rmSync(singleRoot, { recursive: true, force: true })
  }
})
