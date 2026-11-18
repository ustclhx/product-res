import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { m } from '../../paraglide/messages.js'
import { templateConfig } from '../../server/template-config.ts'
import { AiEntry } from './ai-entry.tsx'
import { localized, localizeProduct, type ProductItem } from './localized.ts'
import { ProductMatrix } from './sections/product-matrix.tsx'
import { ProductsEmptyHint } from './sections/products-empty-hint.tsx'
import { Stats } from './sections/stats.tsx'
import { Steps } from './sections/steps.tsx'

// 营销新区块（openspec add-ui-design-system 8.5，marketing-site spec）。链接用页内锚点与外部地址，
// 渲染时不需要路由器；站内路径走 Link 的情况由 e2e/marketing.spec.ts 覆盖。
const escaped = (text: string) =>
  text.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll("'", '&#x27;')

const products: ProductItem[] = ['Atlas', 'Beacon', 'Cobalt'].map((title) => ({
  title,
  description: `${title} description`,
  image: { src: `/shots/${title}.png`, alt: `${title} screenshot` },
  primary: { label: `Open ${title}`, href: `https://product.ezarouter.cc/${title}` },
  secondaryHref: `#${title}`,
}))

describe('数据背书区块', () => {
  it('没有配置数值时不渲染，模板默认不提供任何数值', () => {
    expect(templateConfig.marketing.stats.items).toEqual([])
    expect(renderToString(<Stats items={[]} source="ignored" />)).toBe('')
  })

  it('按配置渲染数值、标签与来源', () => {
    const html = renderToString(
      <Stats
        items={[
          { value: '1,234', label: 'Users' },
          { value: '4.8', label: 'Rating' },
        ]}
        source="Internal data, 2026-10"
      />,
    )
    for (const text of ['1,234', 'Users', '4.8', 'Rating', 'Internal data, 2026-10']) {
      expect(html).toContain(text)
    }
    expect(html).toContain(`aria-label="${escaped(m.marketing_stats_label())}"`)
  })
})

describe('编号产品矩阵', () => {
  it('按顺序编号，每张卡片含图片、主按钮与次级链接', () => {
    const html = renderToString(<ProductMatrix products={products} />)
    const order = ['01', '02', '03'].map((n) => html.indexOf(`>${n}<`))
    expect(order.every((index) => index > 0)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
    for (const product of products) {
      expect(html).toContain(`src="${product.image?.src}"`)
      expect(html).toContain(`alt="${product.image?.alt}"`)
      expect(html).toContain(`href="${product.primary.href}"`)
      expect(html).toContain(`href="${product.secondaryHref}"`)
      // 次级链接文字「了解更多」带读屏可见的产品名，避免多处同名链接
      expect(html).toContain(escaped(m.marketing_products_more_about({ title: product.title })))
    }
  })

  it('没有图片时显示占位框，不输出 img', () => {
    const { image: _image, ...first } = products[0] as ProductItem
    const html = renderToString(<ProductMatrix products={[first]} />)
    expect(html).not.toContain('<img')
    expect(html).toContain(first.title)
  })

  it('未配置产品时不渲染；开发提示是单独组件', () => {
    expect(renderToString(<ProductMatrix products={[]} />)).toBe('')
    expect(renderToString(<ProductsEmptyHint />)).toContain(
      escaped(m.marketing_products_empty_title()),
    )
  })

  it('模板示例产品各语言文案齐全', () => {
    expect(templateConfig.marketing.products.length).toBeGreaterThan(0)
    for (const locale of templateConfig.i18n.locales) {
      for (const product of templateConfig.marketing.products) {
        const item = localizeProduct(product, locale)
        expect(item.title && item.description && item.primary.label).toBeTruthy()
      }
    }
  })
})

describe('三步流程', () => {
  it('按配置渲染为有序列表，未配置时不渲染', () => {
    expect(renderToString(<Steps steps={[]} />)).toBe('')
    const html = renderToString(
      <Steps
        steps={[
          { title: 'First', description: 'One' },
          { title: 'Second', description: 'Two' },
        ]}
      />,
    )
    expect(html).toContain('role="list"')
    expect(html.indexOf('First')).toBeLessThan(html.indexOf('Second'))
    expect(templateConfig.marketing.steps.length).toBeGreaterThan(0)
  })
})

describe('多语言配置文案', () => {
  it('取当前语言，缺失时回退默认语言，字符串原样返回', () => {
    expect(localized('Plain', 'zh')).toBe('Plain')
    expect(localized({ en: 'Hello', zh: '你好' }, 'zh')).toBe('你好')
    const partial = { [templateConfig.i18n.defaultLocale]: 'Fallback' } as Record<string, string>
    expect(localized(partial, 'fr')).toBe('Fallback')
  })
})

describe('悬浮 AI 入口', () => {
  it('固定在右下角、指向配置地址，并带可访问名称', () => {
    const html = renderToString(<AiEntry href="https://product.ezarouter.cc/chat" />)
    expect(html).toContain('href="https://product.ezarouter.cc/chat"')
    expect(html).toContain(`aria-label="${escaped(m.marketing_ai_entry_label())}"`)
    expect(html).toContain('fixed')
    expect(html).toContain(escaped(m.marketing_ai_entry()))
  })
})
