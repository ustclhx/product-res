// 长文阅读器的 Markdown 安全与目录工具（openspec add-ui-design-system tasks 8.4，design D11）。
// 与渲染组件分开：阅读器与对话 Markdown（add-ai-chat-components design D3）共用同一套白名单、链接规则与渲染选项。
import type { Element, Nodes as HastNodes, Root as HastRoot } from 'hast'
import type { Nodes as MdastNodes } from 'mdast'
import type { Options } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkParse from 'remark-parse'
import { unified } from 'unified'

export interface ReaderHeading {
  /** 标题元素的 id，也是目录链接的锚点 */
  readonly id: string
  readonly text: string
  /** 只收集二级与三级标题 */
  readonly level: 2 | 3
}

/**
 * 允许渲染的元素白名单（GFM 子集）。原始 HTML 另由 `skipHtml` 丢弃，这里再兜一层：
 * 白名单之外的元素即使出现在语法树里也不会渲染，元素上也只会有 Markdown 语法能产生的属性。
 */
export const MARKDOWN_ALLOWED_ELEMENTS: readonly string[] = [
  'p',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'ul',
  'ol',
  'li',
  'blockquote',
  'pre',
  'code',
  'em',
  'strong',
  'del',
  'a',
  'img',
  'hr',
  'br',
  'table',
  'thead',
  'tbody',
  'tr',
  'th',
  'td',
  // GFM 任务列表（禁用的复选框）与脚注
  'input',
  'sup',
  'section',
]

const SCHEME = /^([a-z][a-z\d+.-]*):/i
// 浏览器解析 URL 时会去掉前导控制字符与空格，并删除任意位置的制表符和换行（`java\tscript:` 仍是脚本协议）
// biome-ignore lint/suspicious/noControlCharactersInRegex: 正是要匹配并去掉控制字符
const LEADING_CONTROL = /^[\u0000- ]+/
const TAB_OR_NEWLINE = /[\t\n\r]/g

/**
 * 链接与图片地址的协议白名单：只允许 http、https 与站内地址（相对路径、`/`、`#`、`?` 开头）。
 * 其余协议（`javascript:`、`data:`、`vbscript:`、`file:` 等）返回空串，渲染层把它当作「无链接」处理。
 */
export function safeMarkdownUrl(url: string): string {
  const normalized = url.replace(LEADING_CONTROL, '').replace(TAB_OR_NEWLINE, '')
  const scheme = SCHEME.exec(normalized)
  if (!scheme) {
    // 没有协议：站内相对地址。浏览器把反斜杠当作 `/`，开头两个及以上的斜杠 / 反斜杠（如 `/\evil.com`）都解析为
    // `//evil.com`（外站），规范成 `//` 使 isExternalUrl 判为外链；单个反斜杠开头沿用原规则，同样按外链处理
    if (/^[/\\]{2,}/.test(normalized)) return normalized.replace(/^[/\\]+/, '//')
    return normalized.startsWith('\\') ? normalized.replace(/^\\+/, '//') : normalized
  }
  const protocol = scheme[1]?.toLowerCase()
  return protocol === 'http' || protocol === 'https' ? normalized : ''
}

/** 绝对 http(s) 地址或协议相对地址（`//host`）视为外链，新窗口打开并带 `rel="noopener noreferrer"` */
export function isExternalUrl(url: string): boolean {
  return /^(?:https?:|\/\/)/i.test(url)
}

/**
 * 阅读器与对话共用的 react-markdown 安全选项：GFM、丢弃原始 HTML、元素白名单（白名单外的元素展开为子内容）、
 * 链接与图片协议白名单。两处渲染都从这里展开，安全规则只有一个来源；排版组件与 rehype 插件各自传入。
 */
export const MARKDOWN_SAFE_OPTIONS = {
  skipHtml: true,
  allowedElements: MARKDOWN_ALLOWED_ELEMENTS,
  unwrapDisallowed: true,
  remarkPlugins: [remarkGfm],
  urlTransform: safeMarkdownUrl,
} as const satisfies Options

export type MarkdownImagePolicy = 'all' | 'same-origin' | 'none'

/**
 * 图片地址是否按策略放行（地址已经过 `safeMarkdownUrl`）：`all` 允许 http(s) 与站内地址；
 * `same-origin` 只允许站内相对地址（不含 `//host`），服务端与客户端判定一致、不依赖当前域名；`none` 不显示图片。
 */
export function isAllowedImage(src: string, policy: MarkdownImagePolicy): boolean {
  if (!src || policy === 'none') return false
  if (policy === 'all') return true
  return !SCHEME.test(src) && !src.startsWith('//')
}

function textOf(node: MdastNodes): string {
  if ('value' in node && typeof node.value === 'string') return node.value
  if ('children' in node) return node.children.map(textOf).join('')
  return ''
}

export function hastText(node: HastNodes): string {
  if (node.type === 'text') return node.value
  if ('children' in node) return node.children.map((child) => hastText(child as HastNodes)).join('')
  return ''
}

/** 标题文字转为锚点：保留各语言的字母与数字，其余字符折叠为 `-`；加前缀避免与页面已有 id 冲突 */
function slugify(text: string): string {
  const slug = text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
  return `section-${slug || 'untitled'}`
}

const parser = unified().use(remarkParse).use(remarkGfm)

/**
 * 正文中每个二、三级标题（按出现顺序，含空标题）的 id 与文字。id 去重时逐个尝试 `-2`、`-3`… 直到不与已有 id 冲突
 * （`## foo` 两次再加 `## foo 2` 也不会重复）。脚注定义里的标题不计入：渲染时它们在文末的脚注区，不参与目录。
 */
export function extractHeadingSlots(markdown: string): ReaderHeading[] {
  const tree = parser.parse(markdown)
  const used = new Set<string>()
  const headings: ReaderHeading[] = []
  function walk(node: MdastNodes) {
    if (node.type === 'footnoteDefinition') return
    if (node.type === 'heading') {
      if (node.depth === 2 || node.depth === 3) {
        const text = textOf(node).trim()
        const base = slugify(text)
        let id = base
        for (let n = 2; used.has(id); n += 1) id = `${base}-${n}`
        used.add(id)
        headings.push({ id, text, level: node.depth })
      }
      return
    }
    if ('children' in node) for (const child of node.children) walk(child as MdastNodes)
  }
  walk(tree)
  return headings
}

/** 目录：二、三级标题中文字非空的项 */
export function extractHeadings(markdown: string): ReaderHeading[] {
  return extractHeadingSlots(markdown).filter((heading) => heading.text !== '')
}

/**
 * rehype 插件：按出现顺序把 `extractHeadingSlots` 的 id 写到正文的 h2 / h3 上，跳过文末脚注区
 * （`section[data-footnotes]`，其中的「脚注」标题由 remark-rehype 生成）。两边解析同一份源文、同一组语法扩展，
 * 顺序一致；原始 HTML 里的标题已被 skipHtml 丢弃，不参与计数。
 * 传入 `title` 时，正文开头与标题相同的一级标题会被去掉（阅读器已在正文前显示标题）。
 */
export function rehypeHeadingIds(slots: readonly ReaderHeading[], title?: string) {
  return () => (tree: HastRoot) => {
    if (title) {
      const first = tree.children.findIndex((child) => child.type === 'element')
      const node = tree.children[first]
      if (
        node?.type === 'element' &&
        node.tagName === 'h1' &&
        hastText(node).trim() === title.trim()
      ) {
        tree.children.splice(first, 1)
      }
    }
    let index = 0
    function walk(node: HastNodes) {
      if (node.type === 'element') {
        if (node.tagName === 'section' && node.properties.dataFootnotes !== undefined) return
        if (node.tagName === 'h2' || node.tagName === 'h3') {
          const heading = slots[index]
          index += 1
          if (heading) (node as Element).properties.id = heading.id
          return
        }
      }
      if ('children' in node) for (const child of node.children) walk(child as HastNodes)
    }
    walk(tree)
  }
}

/**
 * 流式渲染的按块切分（add-ai-chat-components design D4）：按 mdast 顶层块把源文切成若干段，最后一段是仍在增长的块，
 * 其余各段在后续输入下保持不变，可以各自缓存渲染结果。切分点取顶层块起始行的行首（保留缩进，围栏代码块内的缩进
 * 与整段解析一致），块之间的空行归前一块；只在顶层块边界切分，不会切进代码块、列表或表格内部。
 * 链接引用定义与脚注会跨块生效（后出现的定义改变前面块的渲染、脚注区汇总到文末），树中任何位置出现时返回 `null`，调用方整段渲染。
 */
export function splitMarkdownBlocks(markdown: string): string[] | null {
  const tree = parser.parse(markdown)
  const lineStarts: number[] = []
  for (const child of tree.children) {
    if (hasCrossBlockNode(child)) return null
    const offset = child.position?.start.offset
    if (offset === undefined) return null
    lineStarts.push(markdown.lastIndexOf('\n', offset - 1) + 1)
  }
  if (lineStarts.length <= 1) return [markdown]
  lineStarts[0] = 0
  return lineStarts.map((start, index) => markdown.slice(start, lineStarts[index + 1]))
}

/** 会跨块生效的节点：链接引用定义、脚注定义与引用，嵌在引用块或列表里的定义同样作用于全文 */
function hasCrossBlockNode(node: MdastNodes): boolean {
  if (
    node.type === 'definition' ||
    node.type === 'footnoteDefinition' ||
    node.type === 'footnoteReference'
  ) {
    return true
  }
  return 'children' in node && node.children.some((child) => hasCrossBlockNode(child as MdastNodes))
}
