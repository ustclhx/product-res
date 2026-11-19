// @vitest-environment node
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

// Inter 的度量匹配回退字体（globals.css）：首帧用缩放后的本地 Arial 排版，Inter 换入时不再改变换行。
const globals = readFileSync(new URL('../src/styles/globals.css', import.meta.url), 'utf8').replace(
  /\/\*[\s\S]*?\*\//g,
  '',
)
const interCss = readFileSync(
  createRequire(import.meta.url).resolve('@fontsource-variable/inter/opsz.css'),
  'utf8',
)
const normalize = (value: string) => value.replace(/\s+/g, '').toUpperCase()
const faces = (css: string) => css.match(/@font-face\s*\{[^}]*\}/g) ?? []
const descriptor = (face: string, name: string) =>
  face.match(new RegExp(`(?:^|[;{\\s])${name}\\s*:\\s*([^;}]+)`))?.[1]?.trim() ?? ''
const percent = (value: string) => Number.parseFloat(value)

const family = (name: string) => faces(globals).filter((face) => face.includes(`"${name}"`))
// Arial 一组用于桌面，Roboto 一组用于没有 Arial 的 Android
const fallbacks = [...family('Inter Fallback'), ...family('Inter Fallback Roboto')]
// Inter 拉丁子集（根布局预加载的文件）的 unicode-range
const latin = faces(interCss).find((face) => /inter-latin-opsz-normal/.test(face)) ?? ''

describe('Inter 的度量匹配回退字体', () => {
  it('字体栈中紧跟在 Inter 之后', () => {
    const stack = globals.match(/--font-sans:\s*([^;]+);/)?.[1] ?? ''
    expect(stack.replace(/\s+/g, ' ')).toMatch(
      /^"Inter Variable", "Inter Fallback", "Inter Fallback Roboto", /,
    )
  })

  it('常规与粗体各一条，只引用本地字体，不下载文件', () => {
    for (const name of ['Inter Fallback', 'Inter Fallback Roboto'])
      expect(family(name).map((face) => descriptor(face, 'font-weight'))).toEqual([
        '100 549',
        '550 900',
      ])
    for (const face of fallbacks) {
      expect(descriptor(face, 'src')).toMatch(/^local\(/)
      expect(face).not.toMatch(/url\(/)
    }
  })

  it('只覆盖 Inter 拉丁子集的字符：Inter 加载后外观不受回退字体影响', () => {
    expect(latin).not.toBe('')
    for (const face of fallbacks)
      expect(normalize(descriptor(face, 'unicode-range'))).toBe(
        normalize(descriptor(latin, 'unicode-range')),
      )
  })

  it('纵向度量为 Inter 的 ascender / descender 除以 size-adjust', () => {
    for (const face of fallbacks) {
      const size = percent(descriptor(face, 'size-adjust')) / 100
      expect(percent(descriptor(face, 'ascent-override'))).toBeCloseTo(
        (1984 / 2048 / size) * 100,
        1,
      )
      expect(percent(descriptor(face, 'descent-override'))).toBeCloseTo(
        (494 / 2048 / size) * 100,
        1,
      )
      expect(percent(descriptor(face, 'line-gap-override'))).toBe(0)
    }
  })
})
