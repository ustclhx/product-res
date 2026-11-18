import { uiPresets } from '@product-res/config'
import { UI_PRESETS } from '@product-res/ui'
import type { FontPreload } from '@product-res/ui/fonts'
import { renderToString } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { templateConfig } from '../../server/template-config.ts'

// HeadContent / Scripts 依赖路由上下文，这里只关心 <html> 与 <body> 外壳
vi.mock('@tanstack/react-router', () => ({ HeadContent: () => null, Scripts: () => null }))

// 项目扩展点：默认原样返回，用例中可替换为其他实现
const project = vi.hoisted(() => ({
  override: null as null | ((defaults: readonly FontPreload[]) => readonly FontPreload[]),
}))
vi.mock('./fonts.project.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./fonts.project.ts')>()
  return {
    projectFontPreloads: (defaults: readonly FontPreload[]) =>
      project.override ? project.override(defaults) : actual.projectFontPreloads(defaults),
  }
})

import { RootDocument } from './root-document.tsx'

const render = () =>
  renderToString(
    <RootDocument floatingControls={false}>
      <main>content</main>
    </RootDocument>,
  )
const fontLinks = (html: string) => html.match(/<link[^>]*as="font"[^>]*>/g) ?? []

afterEach(() => {
  project.override = null
})

describe('根布局外壳', () => {
  it('服务端输出 data-preset，取自 template.config.ts 的 ui.preset', () => {
    const html = render()
    expect(html).toMatch(new RegExp(`<html[^>]*data-preset="${templateConfig.ui.preset}"`))
    expect(html).toContain('<main>content</main>')
  })

  it('预设名单只有一个来源：配置校验与组件包一致，当前预设在名单内', () => {
    expect([...uiPresets]).toEqual([...UI_PRESETS])
    expect(UI_PRESETS).toContain(templateConfig.ui.preset)
  })
})

describe('字体预加载扩展点（fonts.project.ts）', () => {
  it('默认预加载模板的 Inter 拉丁子集', () => {
    const links = fontLinks(render())
    expect(links).toHaveLength(1)
    expect(links[0]).toMatch(/rel="preload"/)
    expect(links[0]).toMatch(/inter-latin-opsz/)
    expect(links[0]).toMatch(/type="font\/woff2"/)
  })

  it('项目返回空数组时不输出任何字体 preload', () => {
    project.override = () => []
    expect(fontLinks(render())).toEqual([])
  })

  it('项目可替换或追加', () => {
    project.override = () => [{ href: '/assets/brand.woff2', type: 'font/woff2' }]
    const replaced = fontLinks(render())
    expect(replaced).toHaveLength(1)
    expect(replaced[0]).toMatch(/href="\/assets\/brand.woff2"/)
    project.override = (defaults) => [
      ...defaults,
      { href: '/assets/brand.woff2', type: 'font/woff2' },
    ]
    expect(fontLinks(render())).toHaveLength(2)
  })
})
