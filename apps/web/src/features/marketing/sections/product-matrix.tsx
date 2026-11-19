import { Alert, AlertDescription, AlertTitle, Button } from '@product-res/ui'
import { ArrowRight, CircleAlert, ImageIcon } from '@product-res/ui/icons'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import { m } from '../../../paraglide/messages.js'
import { ConfigLink } from '../config-link.tsx'
import type { ProductItem } from '../localized.ts'

/**
 * 编号产品矩阵（openspec add-ui-design-system 8.5，marketing-site「流程与产品矩阵区块」）：
 * 内容来自模板配置，构建期预渲染。状态：图片加载中显示骨架；图片加载失败时卡片退回占位框并在区块顶部
 * 提示、可重试，文字与按钮不受影响；未配置产品时整个区块不渲染。开发环境的配置提示在单独的
 * products-empty-hint.tsx：与 /dev/ui 共享本模块的 chunk，放在同一文件会被一起打进首页。
 */
export function ProductMatrix({ products }: { products: readonly ProductItem[] }) {
  const [failed, setFailed] = useState<ReadonlySet<number>>(new Set())
  // 重试时换 key 重新挂载图片，浏览器会再次请求
  const [attempt, setAttempt] = useState(0)

  if (products.length === 0) return null

  return (
    <ProductsSection>
      {failed.size > 0 && (
        <Alert variant="destructive">
          <CircleAlert aria-hidden="true" />
          <div className="col-start-2 flex flex-wrap items-start justify-between gap-3">
            <div className="grid gap-0.5">
              <AlertTitle>{m.marketing_products_error_title()}</AlertTitle>
              <AlertDescription>{m.marketing_products_error_body()}</AlertDescription>
            </div>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => {
                setFailed(new Set())
                setAttempt((value) => value + 1)
              }}
            >
              {m.marketing_products_retry()}
            </Button>
          </div>
        </Alert>
      )}
      {/* biome-ignore lint/a11y/noRedundantRoles: list-none 会让 Safari 读屏丢失列表语义，需显式声明 */}
      <ol role="list" className="m-0 grid list-none gap-6 p-0 sm:grid-cols-2 lg:grid-cols-3">
        {products.map((product, index) => (
          <li
            // biome-ignore lint/suspicious/noArrayIndexKey: 配置顺序即编号，标题允许重复
            key={index}
            className="flex flex-col overflow-hidden rounded-xl bg-card shadow-surface-2"
          >
            <div className="relative aspect-16/10 border-border border-b bg-muted text-muted-foreground">
              {product.image && !failed.has(index) ? (
                <ProductImage
                  key={attempt}
                  image={product.image}
                  onError={() => setFailed((current) => new Set(current).add(index))}
                />
              ) : (
                <span aria-hidden="true" className="flex size-full items-center justify-center">
                  <ImageIcon className="size-6" strokeWidth={1.5} />
                </span>
              )}
            </div>
            <div className="flex flex-1 flex-col gap-2 px-6 pt-5 pb-6">
              <span
                aria-hidden="true"
                className="font-semibold text-caption text-muted-foreground tabular-nums"
              >
                {String(index + 1).padStart(2, '0')}
              </span>
              <h3 className="font-semibold text-title">{product.title}</h3>
              <p className="flex-1 text-body text-muted-foreground">{product.description}</p>
              <div className="mt-3 flex flex-wrap items-center gap-4">
                <Button asChild>
                  <ConfigLink href={product.primary.href}>{product.primary.label}</ConfigLink>
                </Button>
                <ConfigLink
                  href={product.secondaryHref}
                  className="inline-flex items-center gap-1 text-body underline-offset-4 hover:underline"
                >
                  {m.marketing_products_more()}
                  <span className="sr-only">
                    {m.marketing_products_more_about({ title: product.title })}
                  </span>
                  <ArrowRight aria-hidden="true" className="size-3.5" />
                </ConfigLink>
              </div>
            </div>
          </li>
        ))}
      </ol>
    </ProductsSection>
  )
}

/** 区块外框与标题行：矩阵与开发环境的配置提示（products-empty-hint.tsx）共用 */
export function ProductsSection({ children }: { children: ReactNode }) {
  return (
    <section id="products" aria-labelledby="products-title" className="pb-24">
      <div className="mx-auto grid max-w-6xl gap-8 px-4">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="grid gap-2">
            <p className="font-medium text-caption text-muted-foreground">
              {m.marketing_products_eyebrow()}
            </p>
            <h2 id="products-title" className="font-bold text-3xl tracking-tight">
              {m.marketing_products_title()}
            </h2>
          </div>
          <a
            href="#features"
            className="inline-flex items-center gap-1 text-body text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
          >
            {m.marketing_products_all()}
            <ArrowRight aria-hidden="true" className="size-3.5" />
          </a>
        </div>
        {children}
      </div>
    </section>
  )
}

/**
 * 16:10 产品截图：图片盖在骨架之上，解码前透出骨架（未水合时同样生效）；加载完成后移除骨架，
 * 失败时交给父级退回占位框。
 * 水合前就已失败或已加载的图片不会再触发事件，挂载时按 complete / naturalWidth 补判一次。
 */
function ProductImage({
  image,
  onError,
}: {
  image: { readonly src: string; readonly alt: string }
  onError: () => void
}) {
  const ref = useRef<HTMLImageElement>(null)
  // 回调存进 ref：父级每次渲染都会传新函数，补判只需在挂载时做一次
  const onErrorRef = useRef(onError)
  onErrorRef.current = onError
  const [loaded, setLoaded] = useState(false)
  useEffect(() => {
    const element = ref.current
    if (!element?.complete) return
    if (element.naturalWidth > 0) setLoaded(true)
    else onErrorRef.current()
  }, [])

  return (
    <>
      {!loaded && (
        <span aria-hidden="true" className="absolute inset-0 bg-active motion-safe:animate-pulse" />
      )}
      <img
        ref={ref}
        src={image.src}
        alt={image.alt}
        width={1600}
        height={1000}
        loading="lazy"
        decoding="async"
        onLoad={() => setLoaded(true)}
        onError={onError}
        className="relative size-full object-cover"
      />
    </>
  )
}
