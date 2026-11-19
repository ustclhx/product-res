import { LayoutGrid } from '@product-res/ui/icons'
import { m } from '../../../paraglide/messages.js'
import { ProductsSection } from './product-matrix.tsx'

/**
 * 未配置产品时的开发提示（只在开发环境渲染；线上没有产品时整个区块不出现）。
 * 调用方写成 `import.meta.env.DEV && <ProductsEmptyHint />`，生产构建据此不引用本模块；
 * 单独成文件，避免随产品矩阵的共享 chunk 进入首页。
 */
export function ProductsEmptyHint() {
  return (
    <ProductsSection>
      <div className="grid justify-items-center gap-2.5 rounded-xl border border-border border-dashed px-4 py-12 text-center">
        <span
          aria-hidden="true"
          className="flex h-20 w-30 items-center justify-center rounded-xl bg-active text-muted-foreground"
        >
          <LayoutGrid className="size-6" strokeWidth={1.5} />
        </span>
        <h3 className="mt-1 font-semibold text-title">{m.marketing_products_empty_title()}</h3>
        <p className="max-w-md text-body text-muted-foreground">
          {m.marketing_products_empty_body()}
        </p>
      </div>
    </ProductsSection>
  )
}
