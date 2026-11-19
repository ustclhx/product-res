import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ChatMarkdown, type ChatMarkdownLabels } from '../src/chat.ts'
import { isExternalUrl, safeMarkdownUrl, splitMarkdownBlocks } from '../src/lib/markdown.ts'

// 记录每次 react-markdown 渲染的源文，用于断言已完成的块不重新渲染
const renders = vi.hoisted(() => [] as string[])
vi.mock('react-markdown', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-markdown')>()
  return {
    ...actual,
    default: (props: Parameters<typeof actual.default>[0]) => {
      renders.push(String(props.children))
      return actual.default(props)
    },
  }
})

// 切分开关：打开时 splitMarkdownBlocks 返回 null，ChatMarkdown 走整段渲染，作为按块渲染的对照
const whole = vi.hoisted(() => ({ force: false }))
vi.mock('../src/lib/markdown.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/markdown.ts')>()
  return {
    ...actual,
    splitMarkdownBlocks: (markdown: string) =>
      whole.force ? null : actual.splitMarkdownBlocks(markdown),
  }
})

const labels: ChatMarkdownLabels = {
  copy: '复制',
  copied: '已复制',
  copyFailed: '复制失败',
  codeBlock: '代码，可横向滚动',
  table: '表格，可横向滚动',
  image: '图片',
  imageAlt: '图片：{alt}',
  footnotes: '脚注',
  footnoteBack: '返回正文',
}

function setClipboard(writeText: (text: string) => Promise<void>) {
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
}

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  renders.length = 0
})

describe('ChatMarkdown 安全渲染', () => {
  it('正文中的原始 HTML 不产生元素', () => {
    const { container } = render(
      <ChatMarkdown
        id="m1"
        labels={labels}
        markdown={
          '前文 <script>alert(1)</script>\n\n<img src="x" onerror="alert(1)">\n\n<iframe src="https://evil.example"></iframe>\n\n行内 <b onclick="x()">粗</b> 结束'
        }
      />,
    )
    expect(container.querySelector('script, img, iframe, b, [onerror], [onclick]')).toBeNull()
    expect(container.textContent).toContain('前文')
    expect(container.textContent).toContain('结束')
  })

  it('javascript: 与 data: 链接显示为纯文字，外链带 rel 并在新窗口打开', () => {
    const { container } = render(
      <ChatMarkdown
        id="m1"
        labels={labels}
        markdown={
          '[点我](javascript:alert(1)) [数据](data:text/html;base64,PHNjcmlwdD4=) [外链](https://product.ezarouter.cc/a) [站内](/app/x)'
        }
      />,
    )
    const links = [...container.querySelectorAll('a')]
    expect(links.map((a) => a.textContent)).toEqual(['外链', '站内'])
    expect(links[0]?.getAttribute('target')).toBe('_blank')
    expect(links[0]?.getAttribute('rel')).toBe('noopener noreferrer nofollow ugc')
    expect(links[1]?.hasAttribute('target')).toBe(false)
    expect(container.textContent).toContain('点我')
    expect(container.textContent).toContain('数据')
    expect(container.innerHTML).not.toMatch(/javascript:|data:text/)
  })

  it('外部图片不产生 <img>，只显示替代文字', () => {
    const { container } = render(
      <ChatMarkdown
        id="m1"
        labels={labels}
        markdown={'趋势见下图：![渠道趋势图](https://evil.example/x.png?q=secret)'}
      />,
    )
    expect(container.querySelector('img')).toBeNull()
    expect(container.textContent).toContain('图片：渠道趋势图')
    expect(container.innerHTML).not.toContain('evil.example')
  })

  it('没有替代文字的图片只显示通用文案', () => {
    const { container } = render(
      <ChatMarkdown id="m1" labels={labels} markdown={'前 ![](https://evil.example/x.png) 后'} />,
    )
    expect(container.querySelector('img')).toBeNull()
    expect(container.textContent).toBe('前 图片 后')
  })

  it('开头两个及以上斜杠 / 反斜杠的地址按外链处理', () => {
    expect(safeMarkdownUrl('/\\evil.com/x')).toBe('//evil.com/x')
    expect(safeMarkdownUrl('\\/evil.com')).toBe('//evil.com')
    expect(safeMarkdownUrl('///evil.com')).toBe('//evil.com')
    expect(isExternalUrl(safeMarkdownUrl('/\\evil.com'))).toBe(true)
    expect(safeMarkdownUrl('/app/x')).toBe('/app/x')
    const { container } = render(
      <ChatMarkdown id="m1" labels={labels} markdown={'[看](/\\evil.com/x)'} />,
    )
    // Markdown 链接中的反斜杠在生成 href 前已被百分号编码，渲染结果解析后仍是站内地址
    const href = container.querySelector('a')?.getAttribute('href') ?? ''
    expect(new URL(href, 'https://app.example').origin).toBe('https://app.example')
  })

  it('表格与代码块在可聚焦、带名称的容器内横向滚动', () => {
    render(
      <ChatMarkdown
        id="m1"
        labels={labels}
        markdown={'| a | b |\n| --- | --- |\n| 1 | 2 |\n\n```python\nprint(1)\n```'}
      />,
    )
    const table = screen.getByRole('group', { name: labels.table })
    expect(table.tabIndex).toBe(0)
    expect(table.className).toContain('overflow-x-auto')
    expect(table.querySelector('table')).not.toBeNull()
    const code = screen.getByRole('group', { name: labels.codeBlock })
    expect(code.tabIndex).toBe(0)
    expect(code.className).toContain('overflow-x-auto')
    expect(code.closest('[data-chat-code]')?.textContent).toContain('python')
  })

  it('滚动容器不是地标：同一页多个表格与代码块不产生重名 region（axe landmark-unique）', () => {
    const markdown = '| a |\n| --- |\n| 1 |\n\n```js\na()\n```'
    const { container } = render(
      <>
        <ChatMarkdown id="m1" labels={labels} markdown={markdown} />
        <ChatMarkdown id="m2" labels={labels} markdown={markdown} />
      </>,
    )
    expect(screen.queryAllByRole('region')).toHaveLength(0)
    expect(container.querySelectorAll('section[aria-label]')).toHaveLength(0)
    expect(screen.getAllByRole('group', { name: labels.table })).toHaveLength(2)
    expect(screen.getAllByRole('group', { name: labels.codeBlock })).toHaveLength(2)
  })

  it('两条消息各有脚注时 id 不冲突', () => {
    const markdown = '正文[^1]。\n\n[^1]: 注释。'
    const { container } = render(
      <>
        <ChatMarkdown id="m1" labels={labels} markdown={markdown} />
        <ChatMarkdown id="m2" labels={labels} markdown={markdown} />
      </>,
    )
    const ids = [...container.querySelectorAll('[id]')].map((element) => element.id)
    expect(ids.length).toBeGreaterThanOrEqual(4)
    expect(new Set(ids).size).toBe(ids.length)
    // 脚注链接与 aria-describedby 指向本条消息自己的元素
    for (const link of container.querySelectorAll('a[href^="#"]')) {
      expect(ids).toContain(link.getAttribute('href')?.slice(1))
    }
    for (const element of container.querySelectorAll('[aria-describedby]')) {
      expect(ids).toContain(element.getAttribute('aria-describedby'))
    }
    expect(screen.getAllByText('脚注').length).toBe(2)
  })
})

describe('代码块复制', () => {
  const markdown = '```ts\nconst a = 1\nconsole.log(a)\n```'

  it('写入剪贴板的文本不含语言名，按钮短暂显示已复制并播报', async () => {
    const writeText = vi.fn(() => Promise.resolve())
    setClipboard(writeText)
    vi.useFakeTimers()
    render(<ChatMarkdown id="m1" labels={labels} markdown={markdown} />)
    expect(screen.getByRole('status').textContent).toBe('')
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '复制' }))
    })
    expect(writeText).toHaveBeenCalledWith('const a = 1\nconsole.log(a)')
    expect(screen.getByRole('button').textContent).toBe('已复制')
    expect(screen.getByRole('status').textContent).toBe('已复制')
    act(() => {
      vi.advanceTimersByTime(1500)
    })
    expect(screen.getByRole('button').textContent).toBe('复制')
    expect(screen.getByRole('status').textContent).toBe('')
  })

  it('剪贴板拒绝时显示失败文案，没有未处理的异常', async () => {
    setClipboard(() => Promise.reject(new DOMException('denied', 'NotAllowedError')))
    render(<ChatMarkdown id="m1" labels={labels} markdown={markdown} />)
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '复制' }))
    })
    expect(screen.getByRole('button').textContent).toBe('复制失败')
    expect(screen.getByRole('status').textContent).toBe('复制失败')
  })

  it('浏览器没有剪贴板接口时同样显示失败文案', async () => {
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true })
    render(<ChatMarkdown id="m1" labels={labels} markdown={markdown} />)
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '复制' }))
    })
    expect(screen.getByRole('status').textContent).toBe('复制失败')
  })
})

const FIXTURES = {
  未闭合代码块: '先看代码：\n\n```python\ndef cac(spend, n):\n    return spend / n\n```\n\n结束。',
  只有表头的表格: '| 渠道 | 新客 |\n| --- | ---: |\n| 搜索 | 1,240 |\n| 内容 | 860 |\n\n表后文字。',
  未闭合强调与链接:
    '这是 **粗体与 [链接](https://product.ezarouter.cc/a?b=1) 混排** 和 _斜体_ 结尾。\n\n第二段 `code`。',
  嵌套列表: '- 一\n  - 一点一\n    1. 甲\n    2. 乙\n- 二\n\n> 引用 **强调**\n\n1. 三\n2. 四',
  脚注: '正文[^a]，还有一处[^b]。\n\n[^a]: 第一条。\n[^b]: 第二条 **粗**。\n\n尾段。',
  标题与分隔线:
    '# 标题\n\n段落一\n段落一续\n\n---\n\n## 小标题\n\n    缩进代码\n\n  ```js\n  const x = 1\n  ```\n',
  嵌套的引用定义:
    '见 [文档][d] 与 [列表][e]。\n\n> [d]: https://product.ezarouter.cc/d\n\n- 项\n\n  [e]: /e\n\n尾段 [d]。',
  原始HTML块:
    '<div class="x">\n<script>alert(1)</script>\n</div>\n\n段落 <span onclick="x()">行内</span> 文字\n\n<!-- 注释 -->\n\n<iframe src="https://evil.example"></iframe>\n尾段。',
} as const satisfies Record<string, string>

/** 整段渲染的结果（切分关闭），作为对照；只取根节点内部，不比较根上的 aria-busy */
function wholeHtml(markdown: string) {
  whole.force = true
  const { container, unmount } = render(
    <ChatMarkdown id="m1" labels={labels} markdown={markdown} />,
  )
  const result = container.firstElementChild?.innerHTML
  unmount()
  whole.force = false
  return result
}

/** 只折叠标签之间的空白，代码块内的换行不受影响；去掉生成中才有的光标标记 */
function normalize(value: string | undefined) {
  return value?.replace(/>\s+</g, '><').replaceAll(' data-chat-tail=""', '')
}

// 逐字符渲染每个前缀两次（按块与整段），机器繁忙时超过默认 5 秒；放宽超时
describe('流式按块增量渲染', { timeout: 60_000 }, () => {
  for (const [name, fixture] of Object.entries(FIXTURES)) {
    it(`${name}：逐字符流式不报错，每一步都与整段渲染相同`, () => {
      const errors = vi.spyOn(console, 'error')
      const { container, rerender } = render(
        <ChatMarkdown id="m1" labels={labels} markdown="" streaming />,
      )
      for (let end = 1; end <= fixture.length; end += 1) {
        const prefix = fixture.slice(0, end)
        rerender(<ChatMarkdown id="m1" labels={labels} markdown={prefix} streaming />)
        const actual = container.firstElementChild?.innerHTML
        const expected = wholeHtml(prefix)
        expect(normalize(actual), `前 ${end} 个字符`).toBe(normalize(expected))
      }
      rerender(<ChatMarkdown id="m1" labels={labels} markdown={fixture} />)
      // 结束后与整段渲染逐字相同（块之间的换行文本也一致）
      expect(container.firstElementChild?.innerHTML).toBe(wholeHtml(fixture))
      expect(container.firstElementChild?.hasAttribute('aria-busy')).toBe(false)
      expect(container.querySelector('script, iframe, [onclick]')).toBeNull()
      expect(errors).not.toHaveBeenCalled()
      errors.mockRestore()
    })
  }

  it('生成中末尾文字块带光标标记，结束后去掉', () => {
    function tails(markdown: string, streaming = true) {
      const { container, unmount } = render(
        <ChatMarkdown id="m1" labels={labels} markdown={markdown} streaming={streaming} />,
      )
      const marked = [...container.querySelectorAll('[data-chat-tail]')].map(
        (element) => `${element.tagName.toLowerCase()}:${element.textContent}`,
      )
      const root = container.firstElementChild?.hasAttribute('data-chat-streaming')
      unmount()
      return { marked, root }
    }
    expect(tails('第一段\n\n第二段')).toEqual({ marked: ['p:第二段'], root: true })
    expect(tails('- 一\n  - 一点一\n    1. 甲').marked).toEqual(['li:甲'])
    expect(tails('- 一\n\n  段落\n- 二\n\n  末段').marked).toEqual(['p:末段'])
    expect(tails('前文\n\n> 引用\n>\n> 末行 **粗**').marked).toEqual(['p:末行 粗'])
    expect(tails('| a | b |\n| --- | --- |\n| 1 | 2 |').marked).toEqual(['td:2'])
    expect(tails('## 标题').marked).toEqual(['h2:标题'])
    // 以代码块结尾（含未闭合的围栏）时不放光标
    expect(tails('前文\n\n```ts\nconst a = 1').marked).toEqual([])
    expect(tails('- 项\n\n  ```\n  x\n  ```').marked).toEqual([])
    // 整段渲染的退路同样标记，脚注区不算末尾
    expect(tails('正文[^1]。\n\n[^1]: 注释。').marked).toEqual(['p:正文1。'])
    expect(tails('第一段\n\n第二段', false)).toEqual({ marked: [], root: false })
  })

  it('生成结束时不重建 DOM：聚焦的复制按钮保持焦点', () => {
    const text = '代码：\n\n```ts\nconst a = 1\n```\n\n后续'
    const { rerender } = render(<ChatMarkdown id="m1" labels={labels} markdown={text} streaming />)
    const button = screen.getByRole('button', { name: '复制' })
    const region = screen.getByRole('group', { name: labels.codeBlock })
    button.focus()
    expect(document.activeElement).toBe(button)
    rerender(<ChatMarkdown id="m1" labels={labels} markdown={`${text}文字。`} streaming />)
    rerender(<ChatMarkdown id="m1" labels={labels} markdown={`${text}文字。`} streaming={false} />)
    expect(document.activeElement).toBe(button)
    expect(screen.getByRole('group', { name: labels.codeBlock })).toBe(region)
  })

  it('已完成的块在后续输入时不重新渲染', () => {
    const fixture = `${FIXTURES.未闭合代码块}\n\n${FIXTURES.嵌套列表}\n\n${FIXTURES.只有表头的表格}`
    const { rerender } = render(<ChatMarkdown id="m1" labels={labels} markdown="" streaming />)
    for (let end = 1; end <= fixture.length; end += 1) {
      renders.length = 0
      rerender(<ChatMarkdown id="m1" labels={labels} markdown={fixture.slice(0, end)} streaming />)
      // 每一步至多渲染两块：仍在增长的最后一块，以及刚刚完成的那一块
      expect(renders.length).toBeLessThanOrEqual(2)
    }
    expect(splitMarkdownBlocks(fixture)?.length).toBeGreaterThan(5)

    // 只在最后一块追加文字：只有最后一块重新渲染，调用方传入新的 labels 对象也不影响
    const blocks = splitMarkdownBlocks(fixture) ?? []
    renders.length = 0
    rerender(<ChatMarkdown id="m1" labels={{ ...labels }} markdown={`${fixture}更多`} streaming />)
    expect(renders).toEqual([`${blocks.at(-1)}更多`])
  })

  it('有脚注或链接引用定义时回退整段渲染', () => {
    expect(splitMarkdownBlocks(FIXTURES.脚注)).toBeNull()
    expect(splitMarkdownBlocks('见 [文档][d]。\n\n[d]: https://product.ezarouter.cc')).toBeNull()
    // 嵌在引用块或列表里的定义同样作用于全文
    expect(splitMarkdownBlocks('见 [文档][d]。\n\n> [d]: https://product.ezarouter.cc')).toBeNull()
    expect(splitMarkdownBlocks(FIXTURES.嵌套的引用定义)).toBeNull()
    renders.length = 0
    render(<ChatMarkdown id="m1" labels={labels} markdown={FIXTURES.脚注} streaming />)
    expect(renders).toEqual([FIXTURES.脚注])
  })

  it('切分点在顶层块起始行的行首，拼接后与原文相同', () => {
    for (const fixture of Object.values(FIXTURES)) {
      const blocks = splitMarkdownBlocks(fixture)
      if (blocks) expect(blocks.join('')).toBe(fixture)
    }
    expect(splitMarkdownBlocks('a\n\n  ```js\n  x\n  ```\n')).toEqual([
      'a\n\n',
      '  ```js\n  x\n  ```\n',
    ])
  })
})
