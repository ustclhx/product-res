// 来源：无（模板新增，openspec add-ai-chat-components tasks 3.2–3.3，design D3 / D4）。对话回复的 Markdown 渲染层：
// 与阅读器共用 lib/markdown.ts 的安全选项（GFM、丢弃原始 HTML、元素白名单、协议白名单），排版为紧凑的对话档，
// 外观按 docs/design-system/prototypes/chat-components/{Main,Mobile,States}.dc.html 的 .md / .tbl / .cb 样式。
// 只经本包的 `chat` 子路径（src/chat.ts）导出，不进主入口与首页包。
import type { Element, Nodes as HastNodes, Root as HastRoot } from 'hast'
import { Check, Copy } from 'lucide-react'
import { Fragment, memo, type ReactNode, useEffect, useMemo, useRef, useState } from 'react'
import Markdown, { type Components, type Options } from 'react-markdown'
import {
  hastText,
  isExternalUrl,
  MARKDOWN_SAFE_OPTIONS,
  splitMarkdownBlocks,
} from '../lib/markdown.ts'
import { cn } from '../lib/utils.ts'

export interface ChatMarkdownLabels {
  /** 代码块复制按钮的文字与可读名称 */
  readonly copy: string
  /** 复制成功后按钮短暂显示的文字，并向读屏播报一次 */
  readonly copied: string
  /** 浏览器拒绝写入剪贴板时显示的文字，并向读屏播报一次 */
  readonly copyFailed: string
  /** 代码块横向滚动区域的可读名称（区域可用键盘聚焦后滚动） */
  readonly codeBlock: string
  /** 表格横向滚动区域的可读名称 */
  readonly table: string
  /** 没有替代文字的图片显示的文案，如「图片」；回复中的图片不加载，只显示文字 */
  readonly image: string
  /** 有替代文字时的显示模板，`{alt}` 替换为替代文字，如「图片：{alt}」 */
  readonly imageAlt: string
  /** 脚注区标题与「返回正文」链接的可读名称（remark-rehype 默认是英文） */
  readonly footnotes: string
  readonly footnoteBack: string
}

export interface ChatMarkdownProps {
  readonly markdown: string
  /** 消息 id：作为脚注 id 前缀，同一页多条回复各有脚注时 id 不冲突 */
  readonly id: string
  readonly labels: ChatMarkdownLabels
  /**
   * 生成中：根节点标记 `aria-busy`。渲染始终按顶层块增量进行（已完成的块不重新渲染），
   * 结束时不整段重建，焦点、选区、复制状态与代码块滚动位置都保留
   */
  readonly streaming?: boolean
  readonly className?: string
}

/** 等宽字号与行高取设计稿的 .md code / .cb pre（12.5px / 19px），比 caption 档略大，长代码更易读 */
const MONO = 'font-mono text-[12.5px] leading-[19px]'
const FOCUS_RING =
  'focus-visible:outline-2 focus-visible:outline-(--focus-ring) focus-visible:outline-offset-2'
const COPY_RESET_MS = 1500

type Labels = ChatMarkdownLabels

/** 图片的显示文字：有替代文字时套模板，没有时只显示通用文案（不留下悬空的「图片：」） */
function imageText(labels: Pick<Labels, 'image' | 'imageAlt'>, alt: string): string {
  const text = alt.trim()
  return text ? labels.imageAlt.replaceAll('{alt}', text) : labels.image
}

function codeElement(node: Element | undefined): Element | undefined {
  const child = node?.children.find((item) => item.type === 'element')
  return child?.type === 'element' && child.tagName === 'code' ? child : undefined
}

/** fence 的语言名：remark-rehype 写成 `language-<info 的第一个词>` */
function languageOf(code: Element | undefined): string {
  const className = code?.properties.className
  const classes = Array.isArray(className) ? className : []
  const language = classes.find((item) => typeof item === 'string' && item.startsWith('language-'))
  return typeof language === 'string' ? language.slice('language-'.length) : ''
}

type CopyState = 'idle' | 'copied' | 'failed'

function CodeBlock({ code, language, labels }: { code: string; language: string; labels: Labels }) {
  const [state, setState] = useState<CopyState>('idle')
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])

  async function copy() {
    clearTimeout(timer.current)
    try {
      // 剪贴板不可用（非安全上下文、权限被拒）时 writeText 不存在或 reject，都显示失败文案，不抛出
      await navigator.clipboard.writeText(code)
      setState('copied')
    } catch {
      setState('failed')
    }
    timer.current = setTimeout(() => setState('idle'), COPY_RESET_MS)
  }

  const Icon = state === 'copied' ? Check : Copy
  return (
    <div
      data-chat-code=""
      className="mb-2.5 overflow-hidden rounded-lg border border-border last:mb-0"
    >
      <div className="flex h-8.5 items-center gap-2 border-border border-b bg-muted/50 pr-1.5 pl-3">
        <span className="min-w-0 flex-1 truncate font-mono text-caption text-muted-foreground">
          {language}
        </span>
        <button
          type="button"
          onClick={copy}
          className={cn(
            'inline-flex h-6 shrink-0 items-center gap-1 rounded-md px-2 text-caption text-muted-foreground hover:bg-hover hover:text-foreground',
            state === 'failed' && 'text-destructive',
            FOCUS_RING,
          )}
        >
          <Icon aria-hidden className="size-3.25" strokeWidth={state === 'copied' ? 2 : 1.5} />
          {state === 'copied'
            ? labels.copied
            : state === 'failed'
              ? labels.copyFailed
              : labels.copy}
        </button>
        {/* 按钮文字变化不一定被读屏朗读，另设礼貌级状态区只在复制结果出现时播报一次 */}
        <span role="status" className="sr-only">
          {state === 'copied' ? labels.copied : state === 'failed' ? labels.copyFailed : ''}
        </span>
      </div>
      {/* 超长行在块内横向滚动；滚动区域可聚焦以便键盘滚动（axe scrollable-region-focusable），用带名称的 group
          而不是 section：带名称的 section 是 region 地标，一页多个代码块时地标重名（axe landmark-unique）。
          外层 overflow-hidden 会裁掉外扩的焦点环，这里改为内缩 */}
      {/* biome-ignore lint/a11y/useSemanticElements: fieldset 是表单分组且带默认边框与 legend 语义；这里只需非地标的命名滚动区域 */}
      <div
        // biome-ignore lint/a11y/noNoninteractiveTabindex: 可滚动区域需要键盘可达
        tabIndex={0}
        role="group"
        aria-label={labels.codeBlock}
        className="overflow-x-auto bg-card focus-visible:outline-2 focus-visible:outline-(--focus-ring) focus-visible:-outline-offset-2"
      >
        <pre className={cn('m-0 w-max min-w-full px-3.5 py-3', MONO)}>
          <code>{code}</code>
        </pre>
      </div>
    </div>
  )
}

const heading = 'mt-3.5 mb-1.5 font-semibold text-subtitle first:mt-0'

function chatComponents(labels: Labels): Components {
  return {
    // 对话档：各级标题统一为 subtitle 粗体，不生成 id、不进目录、不可聚焦
    h1: ({ node: _node, className, ...props }) => (
      <h1 className={cn(heading, className)} {...props} />
    ),
    h2: ({ node: _node, className, ...props }) => (
      <h2 className={cn(heading, className)} {...props} />
    ),
    h3: ({ node: _node, className, ...props }) => (
      <h3 className={cn(heading, className)} {...props} />
    ),
    h4: ({ node: _node, className, ...props }) => (
      <h4 className={cn(heading, className)} {...props} />
    ),
    h5: ({ node: _node, className, ...props }) => (
      <h5 className={cn(heading, className)} {...props} />
    ),
    h6: ({ node: _node, className, ...props }) => (
      <h6 className={cn(heading, 'text-muted-foreground', className)} {...props} />
    ),
    p: ({ node: _node, className, ...props }) => (
      <p className={cn('mb-2.5 last:mb-0', className)} {...props} />
    ),
    ul: ({ node: _node, className, ...props }) => (
      <ul
        className={cn(
          'mb-2.5 list-disc pl-5 last:mb-0 [&_ol]:mb-0 [&_ul]:mb-0 [&_ul]:list-[circle]',
          className,
        )}
        {...props}
      />
    ),
    ol: ({ node: _node, className, ...props }) => (
      <ol
        className={cn('mb-2.5 list-decimal pl-5 last:mb-0 [&_ol]:mb-0 [&_ul]:mb-0', className)}
        {...props}
      />
    ),
    li: ({ node: _node, className, ...props }) => (
      <li className={cn('my-0.75 [&>input]:mr-2 [&>input]:align-middle', className)} {...props} />
    ),
    blockquote: ({ node: _node, className, ...props }) => (
      <blockquote
        className={cn(
          'mb-2.5 border-border border-l-2 pl-3 text-muted-foreground last:mb-0 [&>p:last-child]:mb-0',
          className,
        )}
        {...props}
      />
    ),
    // 代码块：等宽、不高亮，头部显示 fence 语言名与复制按钮；复制的是代码原文（不含语言名与末尾换行）
    pre: ({ node }) => {
      const code = codeElement(node)
      const text = code ? code.children.map(hastText).join('').replace(/\n$/, '') : ''
      return <CodeBlock code={text} language={languageOf(code)} labels={labels} />
    },
    code: ({ node: _node, className, ...props }) => (
      <code className={cn('rounded-sm bg-secondary px-1.25 py-px', MONO, className)} {...props} />
    ),
    a: ({ node: _node, href, className, children, ...props }) => {
      // 协议不在白名单内时 urlTransform 返回空串：渲染为纯文本，不留下可点击的空链接
      if (!href) return <span className={className}>{children}</span>
      const external = isExternalUrl(href)
      return (
        <a
          href={href}
          className={cn(
            'underline underline-offset-3 hover:decoration-2 focus-visible:rounded-xs',
            FOCUS_RING,
            className,
          )}
          {...(external ? { target: '_blank', rel: 'noopener noreferrer nofollow ugc' } : {})}
          {...props}
        >
          {children}
        </a>
      )
    },
    // 图片固定不加载（模型输出的图片地址可把对话内容编码进查询串，自动加载即外泄）：显示替代文字小标签
    img: ({ node: _node, alt }) => (
      <span className="rounded-md px-1.5 py-0.5 text-caption text-muted-foreground inset-ring-1 inset-ring-border">
        {imageText(labels, alt ?? '')}
      </span>
    ),
    hr: ({ node: _node, className, ...props }) => (
      <hr className={cn('my-4 border-border', className)} {...props} />
    ),
    // 表格在自身容器内横向滚动；容器可聚焦以便键盘滚动
    table: ({ node: _node, className, ...props }) => (
      // biome-ignore lint/a11y/useSemanticElements: fieldset 是表单分组且带默认边框与 legend 语义；这里只需非地标的命名滚动区域
      <div
        // biome-ignore lint/a11y/noNoninteractiveTabindex: 可滚动区域需要键盘可达
        tabIndex={0}
        role="group"
        aria-label={labels.table}
        className={cn(
          'mb-2.5 overflow-x-auto rounded-lg border border-border last:mb-0',
          FOCUS_RING,
        )}
      >
        <table
          className={cn(
            'w-full border-collapse text-[13px] leading-[18px] [&_tbody_tr]:border-border [&_tbody_tr]:border-t',
            className,
          )}
          {...props}
        />
      </div>
    ),
    thead: ({ node: _node, className, ...props }) => (
      <thead className={cn('bg-muted/50', className)} {...props} />
    ),
    th: ({ node: _node, className, ...props }) => (
      <th
        className={cn('whitespace-nowrap px-3 py-1.75 text-left font-semibold', className)}
        {...props}
      />
    ),
    td: ({ node: _node, className, ...props }) => (
      <td className={cn('whitespace-nowrap px-3 py-1.75 tabular-nums', className)} {...props} />
    ),
    // GFM 脚注区：与正文分隔，字号小一档（其中的「脚注」标题由 remark-rehype 设为仅读屏可见）
    section: ({ node: _node, className, ...props }) => (
      <section
        className={cn(
          'mt-4 border-border border-t pt-3 text-caption text-muted-foreground',
          className,
        )}
        {...props}
      />
    ),
  }
}

const FOOTNOTE_LABEL_ID = 'footnote-label'

/**
 * rehype 插件：脚注区标题的 id 与脚注引用的 `aria-describedby` 在 mdast-util-to-hast 中写死为 `footnote-label`，
 * 不受 clobberPrefix 影响；同一页多条回复都有脚注时会重复，这里补上同一前缀。
 */
function rehypePrefixFootnoteLabel(prefix: string) {
  return () => (tree: HastRoot) => {
    function walk(node: HastNodes) {
      if (node.type === 'element') {
        const { properties } = node
        if (properties.id === FOOTNOTE_LABEL_ID) properties.id = prefix + FOOTNOTE_LABEL_ID
        const describedBy = properties.ariaDescribedBy
        if (Array.isArray(describedBy)) {
          properties.ariaDescribedBy = describedBy.map((value) =>
            value === FOOTNOTE_LABEL_ID ? prefix + FOOTNOTE_LABEL_ID : value,
          )
        }
      }
      if ('children' in node) for (const child of node.children) walk(child)
    }
    walk(tree)
  }
}

// 流式光标的约定（与 chat 组件的样式共用）：生成中根节点带 `data-chat-streaming`，输出末尾承载文字的块元素带
// `data-chat-tail`，样式用 `[data-chat-streaming] [data-chat-tail]::after` 画光标。
const TEXT_BLOCKS = new Set(['p', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'td', 'th'])
const CONTAINER_BLOCKS = new Set(['ul', 'ol', 'blockquote', 'table', 'thead', 'tbody', 'tr', 'pre'])

function isFootnoteSection(node: HastNodes): boolean {
  return node.type === 'element' && node.tagName === 'section' && 'dataFootnotes' in node.properties
}

/** 节点的最后一个有内容的子节点（跳过块之间的空白文本与文末脚注区） */
function lastChildOf(node: HastRoot | Element): HastNodes | undefined {
  for (let index = node.children.length - 1; index >= 0; index -= 1) {
    const child = node.children[index] as HastNodes
    if (child.type === 'text' && child.value.trim() === '') continue
    if (child.type === 'comment' || isFootnoteSection(child)) continue
    return child
  }
  return undefined
}

/** 末尾最深的文字块；以代码块结尾时返回 `stop`（光标不进代码块，也不放到别处） */
function findTail(node: HastRoot | Element): Element | 'stop' | null {
  if (node.type === 'element' && node.tagName === 'pre') return 'stop'
  const last = lastChildOf(node)
  if (
    last?.type === 'element' &&
    (TEXT_BLOCKS.has(last.tagName) || CONTAINER_BLOCKS.has(last.tagName))
  ) {
    const found = findTail(last)
    if (found) return found
  }
  return node.type === 'element' && TEXT_BLOCKS.has(node.tagName) ? node : null
}

/** rehype 插件：只用于生成中的最后一块（或整段渲染的退路），给末尾文字块加 `data-chat-tail` */
function rehypeMarkTail() {
  return (tree: HastRoot) => {
    const tail = findTail(tree)
    if (tail && tail !== 'stop') tail.properties.dataChatTail = ''
  }
}

interface RenderConfig {
  readonly components: Components
  readonly rehypePlugins: NonNullable<Options['rehypePlugins']>
  readonly remarkRehypeOptions: {
    clobberPrefix: string
    footnoteLabel: string
    footnoteBackLabel: string
  }
}

/** 一段 Markdown 的渲染；props 不变时不重新渲染（流式时已完成的块走这里） */
const MarkdownBlock = memo(function MarkdownBlock({
  source,
  config,
}: {
  source: string
  config: RenderConfig
}) {
  return (
    <Markdown
      {...MARKDOWN_SAFE_OPTIONS}
      components={config.components}
      rehypePlugins={config.rehypePlugins}
      remarkRehypeOptions={config.remarkRehypeOptions}
    >
      {source}
    </Markdown>
  )
})

function safeSplit(markdown: string): string[] | null {
  try {
    return splitMarkdownBlocks(markdown)
  } catch {
    // 切分出错时回退整段渲染（结果一致，只是每次都重新解析全文）
    return null
  }
}

/** id 只保留字母、数字、`-`、`_`，作为脚注锚点前缀 */
function clobberPrefix(id: string): string {
  return `chat-${id.replace(/[^\w-]/g, '_')}-`
}

/**
 * 对话回复的 Markdown。原始 HTML 丢弃，链接只允许 http(s) 与站内地址（其他协议显示为文字），外链新窗口打开并带
 * `rel="noopener noreferrer nofollow ugc"`，图片只显示替代文字；代码块与表格在自身容器内横向滚动。
 */
export const ChatMarkdown = memo(function ChatMarkdown({
  markdown,
  id,
  labels,
  streaming = false,
  className,
}: ChatMarkdownProps) {
  const { copy, copied, copyFailed, codeBlock, table, image, imageAlt, footnotes, footnoteBack } =
    labels
  // 只依赖文案的值：调用方每次传新的 labels 对象时，已完成的块仍保持 memo
  const config = useMemo<RenderConfig>(
    () => ({
      components: chatComponents({
        copy,
        copied,
        copyFailed,
        codeBlock,
        table,
        image,
        imageAlt,
        footnotes,
        footnoteBack,
      }),
      rehypePlugins: [rehypePrefixFootnoteLabel(clobberPrefix(id))],
      remarkRehypeOptions: {
        clobberPrefix: clobberPrefix(id),
        footnoteLabel: footnotes,
        footnoteBackLabel: footnoteBack,
      },
    }),
    [id, copy, copied, copyFailed, codeBlock, table, image, imageAlt, footnotes, footnoteBack],
  )
  // 生成中与结束后都走同一条按块渲染路径：结束时若换成整段渲染，React 会重建全部 DOM，丢失焦点、选区、
  // 「已复制」状态与代码块的横向滚动位置。切分失败或含跨块节点（脚注、引用定义）时才整段渲染。
  // 生成中的最后一块多一个标记光标位置的 rehype 步骤；已完成的块用不带它的 config，memo 不受影响
  const tailConfig = useMemo<RenderConfig>(
    () => ({ ...config, rehypePlugins: [...config.rehypePlugins, rehypeMarkTail] }),
    [config],
  )
  const blocks = useMemo(() => safeSplit(markdown), [markdown])
  let content: ReactNode
  if (blocks) {
    // 按位置作 key：已完成的块源文不再变化，memo 跳过；只有最后一块随输出更新。
    // 块之间补上整段渲染在顶层元素之间输出的换行文本，两条路径的 DOM 一致
    content = blocks.map((source, index) => (
      // biome-ignore lint/suspicious/noArrayIndexKey: 块按出现顺序只增不减，位置即身份
      <Fragment key={index}>
        {index > 0 ? '\n' : null}
        <MarkdownBlock
          source={source}
          config={streaming && index === blocks.length - 1 ? tailConfig : config}
        />
      </Fragment>
    ))
  } else {
    content = <MarkdownBlock source={markdown} config={streaming ? tailConfig : config} />
  }
  return (
    <div
      className={cn('min-w-0 wrap-anywhere text-body', className)}
      aria-busy={streaming || undefined}
      data-chat-streaming={streaming ? '' : undefined}
    >
      {content}
    </div>
  )
})
