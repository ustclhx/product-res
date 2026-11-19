// 来源：无（模板新增，openspec add-ui-design-system tasks 8.4）。阅读器的 Markdown 渲染层：
// react-markdown + remark-gfm，丢弃原始 HTML，元素白名单与链接 / 图片协议白名单见 lib/markdown.ts（与对话 Markdown 共用）。
import { memo, useMemo } from 'react'
import Markdown, { type Components } from 'react-markdown'
import {
  isAllowedImage,
  isExternalUrl,
  MARKDOWN_SAFE_OPTIONS,
  type MarkdownImagePolicy,
  type ReaderHeading,
  rehypeHeadingIds,
} from '../lib/markdown.ts'
import { cn } from '../lib/utils.ts'

// 正文排版：桌面与移动两档取自画板的 .md 样式；h2 打印时从新页开始（第一节紧跟标题不分页）
const baseComponents: Components = {
  h1: ({ node: _node, className, ...props }) => (
    <h2
      className={cn(
        'mt-7 mb-2 scroll-mt-32 group-data-[bar=false]/reader:scroll-mt-20 font-semibold text-lg/6.5 tracking-[-0.005em] outline-none md:mt-10 md:mb-3 md:text-xl/7 lg:scroll-mt-20 lg:group-data-[bar=false]/reader:scroll-mt-6 print:break-after-avoid',
        className,
      )}
      {...props}
    />
  ),
  h2: ({ node: _node, className, ...props }) => (
    <h2
      tabIndex={-1}
      className={cn(
        'mt-7 mb-2 scroll-mt-32 group-data-[bar=false]/reader:scroll-mt-20 font-semibold text-lg/6.5 tracking-[-0.005em] outline-none md:mt-10 md:mb-3 md:text-xl/7 lg:scroll-mt-20 lg:group-data-[bar=false]/reader:scroll-mt-6 print:break-after-avoid print:[&:not(:first-of-type)]:break-before-page',
        className,
      )}
      {...props}
    />
  ),
  h3: ({ node: _node, className, ...props }) => (
    <h3
      tabIndex={-1}
      className={cn(
        'mt-5 mb-1.5 scroll-mt-32 group-data-[bar=false]/reader:scroll-mt-20 font-semibold text-title outline-none md:mt-7 md:mb-2 lg:scroll-mt-20 lg:group-data-[bar=false]/reader:scroll-mt-6 print:break-after-avoid',
        className,
      )}
      {...props}
    />
  ),
  h4: ({ node: _node, className, ...props }) => (
    <h4 className={cn('mt-5 mb-1.5 font-semibold text-subtitle', className)} {...props} />
  ),
  h5: ({ node: _node, className, ...props }) => (
    <h5 className={cn('mt-4 mb-1 font-semibold text-subtitle', className)} {...props} />
  ),
  h6: ({ node: _node, className, ...props }) => (
    <h6
      className={cn('mt-4 mb-1 font-semibold text-muted-foreground text-subtitle', className)}
      {...props}
    />
  ),
  p: ({ node: _node, className, ...props }) => (
    <p className={cn('mb-3 md:mb-3.5', className)} {...props} />
  ),
  ul: ({ node: _node, className, ...props }) => (
    <ul
      className={cn(
        'mb-3 list-disc pl-5 md:mb-3.5 md:pl-5.5 [&_ol]:mb-0 [&_ul]:mb-0 [&_ul]:list-[circle]',
        className,
      )}
      {...props}
    />
  ),
  ol: ({ node: _node, className, ...props }) => (
    <ol
      className={cn(
        'mb-3 list-decimal pl-5 md:mb-3.5 md:pl-5.5 [&_ol]:mb-0 [&_ul]:mb-0',
        className,
      )}
      {...props}
    />
  ),
  li: ({ node: _node, className, ...props }) => (
    <li className={cn('my-1 [&>input]:mr-2 [&>input]:align-middle', className)} {...props} />
  ),
  blockquote: ({ node: _node, className, ...props }) => (
    <blockquote
      className={cn(
        'mb-3 border-border border-l-2 py-0.5 pl-3.5 text-muted-foreground md:mb-3.5 md:pl-4 [&>p:last-child]:mb-0 print:break-inside-avoid',
        className,
      )}
      {...props}
    />
  ),
  pre: ({ node: _node, className, ...props }) => (
    <pre
      className={cn(
        'mb-4 overflow-x-auto rounded-lg bg-muted px-4 py-3.5 font-mono text-caption leading-[18px] inset-ring-1 inset-ring-border [&_code]:rounded-none [&_code]:bg-transparent [&_code]:p-0 print:whitespace-pre-wrap print:break-inside-avoid',
        className,
      )}
      {...props}
    />
  ),
  code: ({ node: _node, className, ...props }) => (
    <code
      className={cn(
        'wrap-break-word rounded-sm bg-active px-1.25 py-px font-mono text-caption',
        className,
      )}
      {...props}
    />
  ),
  a: ({ node: _node, href, className, children, ...props }) => {
    // 协议不在白名单内时 urlTransform 返回空串：渲染为纯文本，不留下可点击的空链接
    if (!href) return <span className={className}>{children}</span>
    const external = isExternalUrl(href)
    return (
      <a
        href={href}
        className={cn(
          'text-primary-text underline underline-offset-4 hover:decoration-2 focus-visible:rounded-xs focus-visible:outline-2 focus-visible:outline-(--focus-ring) focus-visible:outline-offset-2',
          className,
        )}
        {...(external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
        {...props}
      >
        {children}
      </a>
    )
  },
  // GFM 脚注区：与正文分隔，字号小一档（其中的「脚注」标题由 remark-rehype 设为仅读屏可见）
  section: ({ node: _node, className, ...props }) => (
    <section
      className={cn(
        'mt-8 border-border border-t pt-4 text-caption text-muted-foreground',
        className,
      )}
      {...props}
    />
  ),
  hr: ({ node: _node, className, ...props }) => (
    <hr className={cn('my-8 border-border', className)} {...props} />
  ),
  // 窄屏下表格在自身容器内横向滚动，页面不出现横向滚动
  table: ({ node: _node, className, ...props }) => (
    <div className="mb-4 overflow-x-auto rounded-md border border-border print:overflow-visible">
      <table className={cn('w-full border-collapse text-body', className)} {...props} />
    </div>
  ),
  thead: ({ node: _node, className, ...props }) => (
    <thead className={cn('bg-muted/50', className)} {...props} />
  ),
  tr: ({ node: _node, className, ...props }) => (
    <tr
      className={cn('border-border border-b last:border-b-0 print:break-inside-avoid', className)}
      {...props}
    />
  ),
  th: ({ node: _node, className, ...props }) => (
    <th
      className={cn(
        'whitespace-nowrap px-3 py-2 text-left font-medium text-muted-foreground',
        className,
      )}
      {...props}
    />
  ),
  td: ({ node: _node, className, ...props }) => (
    <td className={cn('px-3 py-2 tabular-nums', className)} {...props} />
  ),
}

const componentsByPolicy = new Map<MarkdownImagePolicy, Components>()

/** 每种图片策略一份稳定的 components 表（模块级缓存，避免每次渲染新建对象使 react-markdown 重建元素） */
function componentsFor(policy: MarkdownImagePolicy): Components {
  const cached = componentsByPolicy.get(policy)
  if (cached) return cached
  const components: Components = {
    ...baseComponents,
    img: ({ node: _node, src, alt, className, ...props }) =>
      typeof src === 'string' && isAllowedImage(src, policy) ? (
        <img
          src={src}
          alt={alt ?? ''}
          loading="lazy"
          referrerPolicy="no-referrer"
          className={cn('my-2 h-auto max-w-full rounded-lg', className)}
          {...props}
        />
      ) : alt ? (
        <span className={className}>{alt}</span>
      ) : null,
  }
  componentsByPolicy.set(policy, components)
  return components
}

export interface ReaderMarkdownProps {
  readonly markdown: string
  /** extractHeadingSlots 的结果，按顺序写入 h2 / h3 的 id */
  readonly slots: readonly ReaderHeading[]
  /** 正文开头与之相同的一级标题会被去掉 */
  readonly title: string
  readonly images: MarkdownImagePolicy
  /** 脚注区标题与「返回正文」链接的可读名称（remark-rehype 默认是英文） */
  readonly footnoteLabel: string
  readonly footnoteBackLabel: string
}

/** 只在源文、标题、策略或文案变化时重新解析；阅读进度与当前节变化不会让正文重渲染 */
export const ReaderMarkdown = memo(function ReaderMarkdown({
  markdown,
  slots,
  title,
  images,
  footnoteLabel,
  footnoteBackLabel,
}: ReaderMarkdownProps) {
  const rehypePlugins = useMemo(() => [rehypeHeadingIds(slots, title)], [slots, title])
  const remarkRehypeOptions = useMemo(
    () => ({ footnoteLabel, footnoteBackLabel }),
    [footnoteLabel, footnoteBackLabel],
  )
  return (
    <Markdown
      {...MARKDOWN_SAFE_OPTIONS}
      rehypePlugins={rehypePlugins}
      remarkRehypeOptions={remarkRehypeOptions}
      components={componentsFor(images)}
    >
      {markdown}
    </Markdown>
  )
})
