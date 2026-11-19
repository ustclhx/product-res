import { log } from '@product-res/shared/log'
import { renderToString } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { templateConfig } from '../../server/template-config.ts'
import { resolveHtmlAttributes } from './html-attributes.server.ts'
import { getProjectHtmlAttributes } from './html-attributes.ts'
import type { ProjectHtmlAttributes } from './html-attributes.types.ts'
import { RootDocument } from './root-document.tsx'

vi.mock('./html-attributes.ts', () => ({ getProjectHtmlAttributes: vi.fn(() => ({})) }))
vi.mock('@tanstack/react-router', () => ({ HeadContent: () => null, Scripts: () => null }))

afterEach(() => vi.restoreAllMocks())

describe('项目根文档属性', () => {
  it('按请求计算站点，SSR 与序列化后的水合数据产生相同的 html 属性', () => {
    vi.mocked(getProjectHtmlAttributes).mockImplementation(({ host, locale, pathname }) => ({
      'data-site':
        host === 'east.example.com' && locale === 'en' && pathname === '/' ? 'east' : 'west',
      dir: 'ltr',
      title: 'Project <site>',
      translate: 'no',
    }))
    const context = { host: 'east.example.com', locale: 'en', pathname: '/' }
    const attributes = resolveHtmlAttributes(context)
    const render = (htmlAttributes: Record<string, string>) =>
      renderToString(
        <RootDocument floatingControls={false} htmlAttributes={htmlAttributes}>
          <main>content</main>
        </RootDocument>,
      )
    const html = render(attributes)
    expect(getProjectHtmlAttributes).toHaveBeenCalledWith(context)
    expect(html).toContain('data-site="east"')
    expect(html).toContain('dir="ltr"')
    expect(html).toContain('title="Project &lt;site&gt;"')
    expect(html).toContain('translate="no"')
    expect(render(JSON.parse(JSON.stringify(attributes)))).toBe(html)
    expect(resolveHtmlAttributes({ ...context, pathname: '/west' })['data-site']).toBe('west')
  })

  it('拒绝模板属性、事件、非白名单属性与无效值，警告不包含属性值', () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {})
    const rejected = {
      'data-preset': 'project-secret',
      lang: 'project-secret',
      onClick: 'project-secret',
      className: 'project-secret',
      style: 'project-secret',
      'data-Bad': 'project-secret',
      'data-value': { secret: true },
      dir: 'project-secret',
      translate: 'project-secret',
    }
    vi.mocked(getProjectHtmlAttributes).mockReturnValue({
      ...rejected,
      'data-site': 'east',
    } as unknown as ProjectHtmlAttributes)
    const attributes = resolveHtmlAttributes({ host: 'example.com', locale: 'en', pathname: '/' })
    expect(attributes).toEqual({ 'data-site': 'east' })
    expect(warn.mock.calls).toEqual(
      Object.keys(rejected).map((attribute) => ['theme.html_attribute_ignored', { attribute }]),
    )
    const html = renderToString(
      <RootDocument floatingControls={false} htmlAttributes={attributes}>
        <main>content</main>
      </RootDocument>,
    )
    expect(html).toContain(`data-preset="${templateConfig.ui.preset}"`)
    expect(html).not.toContain('project-secret')
  })
})
