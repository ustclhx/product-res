import { fileURLToPath } from 'node:url'
import { AppError } from '@product-res/shared'
import { describe, expect, it, vi } from 'vitest'
import { resolveProjectShareCardFonts } from '../features/share-cards/fonts.ts'
import { sampleShareCardLayout } from '../features/share-cards/layout.tsx'
import {
  createShareCardRenderer,
  SHARE_CARD_BUSY,
  type ShareCardFont,
  type ShareCardImageEngine,
} from '../features/share-cards/renderer.ts'
import { resolveShareCardTheme } from '../features/share-cards/theme.ts'
import { createNodeShareCardRenderer } from './share-card-renderer.ts'

const fontDir = fileURLToPath(new URL('../../public/fonts/share-card', import.meta.url))

/** PNG 签名与 IHDR 中的宽高。 */
function pngSize(png: Uint8Array) {
  expect([...png.slice(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10])
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength)
  return { width: view.getUint32(16), height: view.getUint32(20) }
}

const samples = {
  zh: {
    title: '2026 年第三季度用户调研要点',
    description: '新用户留存提升 12%，主要来自引导流程简化；移动端满意度仍低于桌面端。',
    label: '报告摘要',
    meta: '5 条结论 · 3 个风险',
  },
  en: {
    title: 'Q3 2026 user research highlights',
    description:
      'Retention for new users rose 12%, driven by a simpler onboarding flow. Mobile satisfaction still trails desktop.',
    label: 'Report',
    meta: '5 findings · 3 risks',
  },
  long: {
    title:
      '面向中小团队的跨部门协作流程梳理：从需求收集、优先级评估到交付复盘的完整实践记录与改进建议',
    description:
      '梳理了需求从收集到复盘的 7 个环节，指出评估阶段信息缺失是延期的首要原因，并给出三项可在两周内落地的改进。整理过程中还对比了四个团队的做法。',
    label: '报告摘要',
    meta: '7 个环节 · 3 项建议',
  },
}

describe('Node 分享卡片渲染器（4.3）', () => {
  const renderer = createNodeShareCardRenderer(fontDir)

  for (const [name, data] of Object.entries(samples)) {
    it(`渲染${name}样张为 1200×630 PNG`, async () => {
      const png = await renderer.render(sampleShareCardLayout(data, resolveShareCardTheme('light')))
      expect(pngSize(png)).toEqual({ width: 1200, height: 630 })
    }, 30_000)
  }

  it('同一目录复用同一个渲染器实例', () => {
    expect(createNodeShareCardRenderer(fontDir)).toBe(renderer)
  })
})

describe('渲染核心', () => {
  const latin: ShareCardFont[] = [
    { name: 'Inter', data: new ArrayBuffer(1), weight: 400, style: 'normal' },
  ]
  const ok = () => Promise.resolve(new Response(new Uint8Array([1, 2, 3])))

  it('只有文本含 CJK 时加载 CJK 字体，且实例内只加载一次', async () => {
    const loadCjkFont = vi.fn(async () => new ArrayBuffer(2))
    const engine = vi.fn<ShareCardImageEngine>(ok)
    const renderer = createShareCardRenderer({ engine, loadLatinFonts: () => latin, loadCjkFont })
    await renderer.render(<div>English only</div>)
    expect(loadCjkFont).not.toHaveBeenCalled()
    await renderer.render(<div>中文标题</div>)
    await renderer.render(<div>又一个中文标题</div>)
    expect(loadCjkFont).toHaveBeenCalledTimes(1)
    const fonts = engine.mock.calls.map(([, options]) => options.fonts)
    expect(fonts[0]).toHaveLength(1)
    expect(fonts[1]?.map((font) => font.name)).toEqual(['Inter', 'Noto Sans SC'])
    // 字体数组在实例内复用
    expect(fonts[2]).toBe(fonts[1])
  })

  it('项目字体只在文本含其登记文字时读取，排在 Noto 之后并在实例内缓存', async () => {
    const projectFonts = resolveProjectShareCardFonts([
      { name: 'Noto Sans KR', file: 'NotoSansKR-Regular.otf', scripts: ['Hangul'] },
    ])
    const loadCjkFont = vi.fn(async () => new ArrayBuffer(2))
    const loadProjectFont = vi.fn(async (_file: string) => new ArrayBuffer(3))
    const engine = vi.fn<ShareCardImageEngine>(ok)
    const renderer = createShareCardRenderer({
      engine,
      loadLatinFonts: () => latin,
      loadCjkFont,
      loadProjectFont,
      projectFonts,
    })
    await renderer.render(<div>English only</div>)
    await renderer.render(<div>中文标题</div>)
    expect(loadProjectFont).not.toHaveBeenCalled()
    await renderer.render(<div>보고서</div>)
    await renderer.render(<div>보고서 报告</div>)
    await renderer.render(<div>다른 보고서</div>)
    expect(loadProjectFont).toHaveBeenCalledTimes(1)
    expect(loadProjectFont).toHaveBeenCalledWith('NotoSansKR-Regular.otf')
    expect(loadCjkFont).toHaveBeenCalledTimes(1)
    const fonts = engine.mock.calls.map(([, options]) => options.fonts.map((font) => font.name))
    expect(fonts[2]).toEqual(['Inter', 'Noto Sans KR'])
    expect(fonts[3]).toEqual(['Inter', 'Noto Sans SC', 'Noto Sans KR'])
    expect(engine.mock.calls[4]?.[1].fonts).toBe(engine.mock.calls[2]?.[1].fonts)
  })

  it('项目字体读取失败不缓存，下次重试', async () => {
    const loadProjectFont = vi
      .fn<(file: string) => Promise<ArrayBuffer>>()
      .mockRejectedValueOnce(new Error('asset 404'))
      .mockResolvedValue(new ArrayBuffer(3))
    const renderer = createShareCardRenderer({
      engine: ok,
      loadLatinFonts: () => latin,
      loadCjkFont: async () => new ArrayBuffer(2),
      loadProjectFont,
      projectFonts: resolveProjectShareCardFonts([
        { name: 'Noto Sans KR', file: 'NotoSansKR-Regular.otf', scripts: ['Hangul'] },
      ]),
    })
    await expect(renderer.render(<div>보고서</div>)).rejects.toThrow('asset 404')
    await expect(renderer.render(<div>보고서</div>)).resolves.toBeInstanceOf(Uint8Array)
    expect(loadProjectFont).toHaveBeenCalledTimes(2)
  })

  it('CJK 字体读取失败不缓存，下次重试', async () => {
    const loadCjkFont = vi
      .fn<() => Promise<ArrayBuffer>>()
      .mockRejectedValueOnce(new Error('asset 503'))
      .mockResolvedValue(new ArrayBuffer(2))
    const renderer = createShareCardRenderer({
      engine: ok,
      loadLatinFonts: () => latin,
      loadCjkFont,
    })
    await expect(renderer.render(<div>中文</div>)).rejects.toThrow('asset 503')
    await expect(renderer.render(<div>中文</div>)).resolves.toBeInstanceOf(Uint8Array)
    expect(loadCjkFont).toHaveBeenCalledTimes(2)
  })

  it('同一实例并发超过 2 时返回 503，完成后恢复', async () => {
    const releases: (() => void)[] = []
    const engine = () =>
      new Promise<Response>((resolve) => {
        releases.push(() => resolve(new Response(new Uint8Array([1]))))
      })
    const renderer = createShareCardRenderer({
      engine,
      loadLatinFonts: () => latin,
      loadCjkFont: async () => new ArrayBuffer(2),
    })
    const first = renderer.render(<div>a</div>)
    const second = renderer.render(<div>b</div>)
    const third = renderer.render(<div>c</div>)
    await expect(third).rejects.toBeInstanceOf(AppError)
    await expect(third).rejects.toMatchObject({ code: SHARE_CARD_BUSY, status: 503 })
    await vi.waitFor(() => expect(releases).toHaveLength(2))
    for (const release of releases) release()
    await Promise.all([first, second])
    const fourth = renderer.render(<div>d</div>)
    await vi.waitFor(() => expect(releases).toHaveLength(3))
    releases[2]?.()
    await expect(fourth).resolves.toBeInstanceOf(Uint8Array)
  })
})
