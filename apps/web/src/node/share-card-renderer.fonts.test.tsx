// 端到端：项目在 share-cards.fonts.ts 登记谚文字体后，Node 渲染器从字体目录按需读取并交给 satori。
// 夹具 __fixtures__/hangul-test.ttf 只有几个谚文字符的方块字形（make-hangul-test-font.py 生成），模板不附带真实韩文字体。
import { copyFile, mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ImageResponse } from 'cf-workers-og/node'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('../features/share-cards/share-cards.fonts.ts', () => ({
  projectShareCardFonts: [{ name: 'Hangul Test', file: 'hangul-test.ttf', scripts: ['Hangul'] }],
}))

const { sampleShareCardLayout, titleWeight } = await import('../features/share-cards/layout.tsx')
const { resolveShareCardTheme } = await import('../features/share-cards/theme.ts')
const { shareCardFontFingerprint } = await import('../features/share-cards/fonts.ts')
const { createShareCardRenderer, LATIN_FONT_FILES } = await import(
  '../features/share-cards/renderer.ts'
)
const { createNodeShareCardRenderer } = await import('./share-card-renderer.ts')

const publicFonts = fileURLToPath(new URL('../../public/fonts/share-card', import.meta.url))
const fixture = fileURLToPath(new URL('./__fixtures__/hangul-test.ttf', import.meta.url))

describe('项目谚文字体（Node 渲染器）', () => {
  let fontDir = ''

  beforeAll(async () => {
    // 模拟项目的字体目录：模板字体加上项目自带的谚文字体
    fontDir = await mkdtemp(join(tmpdir(), 'share-card-fonts-'))
    for (const name of await readdir(publicFonts))
      await copyFile(join(publicFonts, name), join(fontDir, name))
    await copyFile(fixture, join(fontDir, 'hangul-test.ttf'))
  })
  afterAll(async () => {
    await rm(fontDir, { recursive: true, force: true })
  })

  const card = (title: string) =>
    sampleShareCardLayout(
      { title, description: '', label: '', meta: '' },
      resolveShareCardTheme('light'),
    )

  it('含谚文时用登记的字体渲染，结果与缺字时不同', async () => {
    const withFont = await createNodeShareCardRenderer(fontDir).render(card('한국어 보고서'))
    // 同一文本不加载项目字体：谚文缺字
    const without = await createShareCardRenderer({
      engine: (element, options) => ImageResponse.create(element, options),
      // 与 Node 渲染器相同的西文字体，只少项目字体
      loadLatinFonts: () =>
        Promise.all(
          LATIN_FONT_FILES.map(async ({ file, weight }) => ({
            name: 'Inter',
            data: new Uint8Array(await readFile(join(publicFonts, file))).buffer,
            weight,
            style: 'normal' as const,
          })),
        ),
      loadCjkFont: async () => new ArrayBuffer(0),
      projectFonts: [],
    }).render(card('한국어 보고서'))
    expect(Buffer.from(withFont).equals(Buffer.from(without))).toBe(false)
  }, 30_000)

  it('登记的字体文件缺失时渲染失败，不静默输出缺字图片', async () => {
    await expect(createNodeShareCardRenderer(publicFonts).render(card('한국어'))).rejects.toThrow(
      /hangul-test\.ttf/,
    )
  }, 30_000)

  it('登记后谚文标题使用 400 字重，字体指纹进入卡片地址', () => {
    expect(titleWeight('한국어 보고서')).toBe(400)
    expect(titleWeight('Report')).toBe(600)
    expect(shareCardFontFingerprint()).toMatch(/^[0-9a-f]{8}$/)
  })
})
