import type { LocalizedText, MarketingProduct } from '@product-res/config'
import { getLocale } from '../../paraglide/runtime.js'
import { templateConfig } from '../../server/template-config.ts'

/**
 * 取模板配置中营销文案的当前语言版本：缺少当前语言时回退默认语言（i18n 关闭的单语言项目常只写一种）。
 * 类型检查已要求多语言写全，这里的回退只防御手写 JSON 等绕过类型的情况。
 */
export function localized(text: LocalizedText, locale: string = getLocale()): string {
  if (typeof text === 'string') return text
  const record: Readonly<Record<string, string>> = text
  return record[locale] ?? record[templateConfig.i18n.defaultLocale] ?? ''
}

/** 产品矩阵一项解析为当前语言后的展示数据（区块组件只接收这一形状，/dev/ui 可直接传示例数据） */
export interface ProductItem {
  readonly title: string
  readonly description: string
  readonly image?: { readonly src: string; readonly alt: string }
  readonly primary: { readonly label: string; readonly href: string }
  readonly secondaryHref: string
}

export function localizeProduct(product: MarketingProduct, locale?: string): ProductItem {
  return {
    title: localized(product.title, locale),
    description: localized(product.description, locale),
    ...(product.image && {
      image: { src: product.image.src, alt: localized(product.image.alt, locale) },
    }),
    primary: { label: localized(product.primary.label, locale), href: product.primary.href },
    secondaryHref: product.secondaryHref,
  }
}
