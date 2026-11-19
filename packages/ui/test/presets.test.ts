// @vitest-environment node
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { badgeColors } from '../src/components/badge.tsx'
import { UI_PRESETS } from '../src/index.ts'

// 主题预设的对比度：从 globals.css 与 presets/*.css 读取变量，按「基线 → 预设」「浅色 → .dark」的层叠顺序
// 解析，半透明色与 color-mix 先与底色混合，再按 WCAG 相对亮度计算。正文 ≥ 4.5:1，焦点环 ≥ 3:1。
const styles = new URL('../src/styles/', import.meta.url)
const read = (name: string) => readFileSync(new URL(name, styles), 'utf8')
const stripComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '')

type Vars = Record<string, string>
type Rgba = [number, number, number, number]

/** 取出指定选择器（完全匹配）规则块中的自定义属性 */
function block(css: string, selector: string): Vars {
  const vars: Vars = {}
  for (const match of stripComments(css).matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    // 选择器文本可能带着前面的 @import 等语句，只取最后一个分号之后的部分
    const selectors = (match[1] ?? '')
      .split(';')
      .at(-1)
      ?.split(',')
      .map((s) => s.trim())
    if (!selectors?.includes(selector)) continue
    for (const decl of (match[2] ?? '').matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
      vars[decl[1] as string] = (decl[2] as string).replace(/\s+/g, ' ').trim()
    }
  }
  return vars
}

/** 规则块所在的 @layer 名；不在任何 layer 中时返回 null */
function layerOf(css: string, selector: string): string | null {
  const text = stripComments(css)
  const stack: string[] = []
  let start = 0
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '{') {
      const prelude = (text.slice(start, i).split(';').at(-1) ?? '').trim()
      if (prelude === selector) return stack.find((p) => p.startsWith('@layer'))?.slice(7) ?? null
      stack.push(prelude)
      start = i + 1
    } else if (text[i] === '}') {
      stack.pop()
      start = i + 1
    }
  }
  throw new Error(`未找到规则 ${selector}`)
}

const srgbToLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
const linearToSrgb = (c: number) => (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055)
const clamp = (v: number) => Math.min(1, Math.max(0, v))

function oklabToRgb(l: number, a: number, b: number): [number, number, number] {
  const l_ = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const m_ = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const s_ = (l - 0.0894841775 * a - 1.291485548 * b) ** 3
  return [
    4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_,
    -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_,
    -0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_,
  ].map((v) => clamp(linearToSrgb(v))) as [number, number, number]
}

function rgbToOklab([r, g, b]: [number, number, number]): [number, number, number] {
  const [lr, lg, lb] = [r, g, b].map(srgbToLinear) as [number, number, number]
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb)
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb)
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb)
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ]
}

/** 解析为 sRGB（0–1）加不透明度；支持 var()、#hex、rgb()、oklch()、color-mix(in oklab, …) */
function parse(value: string, vars: Vars, depth = 0): Rgba {
  const v = value.trim()
  if (depth > 20) throw new Error(`变量循环 ${value}`)
  const ref = /^var\((--[\w-]+)\)$/.exec(v)
  if (ref) {
    const next = vars[ref[1] as string]
    if (next === undefined) throw new Error(`未定义的变量 ${ref[1]}`)
    return parse(next, vars, depth + 1)
  }
  if (v === 'transparent') return [0, 0, 0, 0]
  if (v === 'black') return [0, 0, 0, 1]
  if (v === 'white') return [1, 1, 1, 1]
  const hex = /^#([0-9a-f]{6})$/i.exec(v)
  if (hex) {
    const n = Number.parseInt(hex[1] as string, 16)
    return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255, 1]
  }
  const rgb = /^rgb\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*(?:\/\s*([\d.]+))?\s*\)$/.exec(v)
  if (rgb) {
    const [r, g, b] = [rgb[1], rgb[2], rgb[3]].map((c) => Number(c) / 255) as [
      number,
      number,
      number,
    ]
    return [r, g, b, rgb[4] === undefined ? 1 : Number(rgb[4])]
  }
  const oklch = /^oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\)$/.exec(v)
  if (oklch) {
    const [l, c, h] = [Number(oklch[1]), Number(oklch[2]), (Number(oklch[3]) * Math.PI) / 180]
    return [...oklabToRgb(l, c * Math.cos(h), c * Math.sin(h)), 1]
  }
  const mix = /^color-mix\(in (oklab|srgb),\s*(.+?)\s+([\d.]+)%,\s*(.+)\)$/.exec(v)
  if (mix)
    return (mix[1] === 'srgb' ? mixSrgb : mixOklab)(
      parse(mix[2] as string, vars, depth + 1),
      Number(mix[3]) / 100,
      parse(mix[4] as string, vars, depth + 1),
    )
  throw new Error(`无法解析的颜色 ${value}`)
}

/** CSS color-mix(in oklab, A p, B)：按预乘不透明度在 oklab 中插值 */
function mixOklab(a: Rgba, p: number, b: Rgba): Rgba {
  const alpha = a[3] * p + b[3] * (1 - p)
  if (alpha === 0) return [0, 0, 0, 0]
  const la = rgbToOklab([a[0], a[1], a[2]])
  const lb = rgbToOklab([b[0], b[1], b[2]])
  const lab = [0, 1, 2].map(
    (i) => ((la[i] as number) * a[3] * p + (lb[i] as number) * b[3] * (1 - p)) / alpha,
  ) as [number, number, number]
  return [...oklabToRgb(...lab), alpha]
}

/** CSS color-mix(in srgb, A p, B)：按预乘不透明度在 sRGB 中插值（Badge 的淡底） */
function mixSrgb(a: Rgba, p: number, b: Rgba): Rgba {
  const alpha = a[3] * p + b[3] * (1 - p)
  if (alpha === 0) return [0, 0, 0, 0]
  return [0, 1, 2]
    .map((i) => ((a[i] as number) * a[3] * p + (b[i] as number) * b[3] * (1 - p)) / alpha)
    .concat(alpha) as Rgba
}

/** 半透明前景叠在不透明底色上 */
function over(top: Rgba, bottom: Rgba): Rgba {
  const a = top[3]
  return [0, 1, 2]
    .map((i) => (top[i] as number) * a + (bottom[i] as number) * (1 - a))
    .concat(1) as Rgba
}

const alpha = (c: Rgba, a: number): Rgba => [c[0], c[1], c[2], c[3] * a]
const luminance = (c: Rgba) =>
  0.2126 * srgbToLinear(c[0]) + 0.7152 * srgbToLinear(c[1]) + 0.0722 * srgbToLinear(c[2])

function contrast(fg: Rgba, bg: Rgba): number {
  const base = over(bg, [1, 1, 1, 1])
  const [hi, lo] = [luminance(over(fg, base)), luminance(base)].sort((x, y) => y - x) as [
    number,
    number,
  ]
  return (hi + 0.05) / (lo + 0.05)
}

type Check = { name: string; fg: Rgba; bg: Rgba; min: number }

/** 需要满足对比度的组合；与 Button、Alert、Dialog 等组件实际使用的类名对应 */
function checks(vars: Vars, mode: 'light' | 'dark'): Check[] {
  const c = (name: string) => parse(`var(${name})`, vars)
  const page = c('--background')
  const onPage = (top: Rgba) => over(top, page)
  const primary = c('--primary')
  const destructive = c('--destructive')
  // Button destructive：浅色 /10、悬停 /15；深色 /15、悬停 /20
  const [rest, hover] = mode === 'light' ? [0.1, 0.15] : [0.15, 0.2]
  const text = (name: string, fg: Rgba, bg: Rgba): Check => ({ name, fg, bg, min: 4.5 })
  const ui = (name: string, fg: Rgba, bg: Rgba): Check => ({ name, fg, bg, min: 3 })
  return [
    text('正文 foreground / background', c('--foreground'), page),
    text('card-foreground / card', c('--card-foreground'), c('--card')),
    text('popover-foreground / popover', c('--popover-foreground'), c('--popover')),
    text('muted-foreground / background', c('--muted-foreground'), page),
    text('muted-foreground / muted', c('--muted-foreground'), onPage(c('--muted'))),
    text('弹窗内 muted-foreground / surface-5', c('--muted-foreground'), c('--surface-5')),
    text('弹窗内 muted-foreground / surface-7', c('--muted-foreground'), c('--surface-7')),
    text('主按钮文字', c('--primary-foreground'), primary),
    text('主按钮悬停', c('--primary-foreground'), mixOklab(primary, 0.88, [0, 0, 0, 1])),
    text('主按钮按下', c('--primary-foreground'), mixOklab(primary, 0.78, [0, 0, 0, 1])),
    text('secondary 按钮', c('--secondary-foreground'), onPage(c('--tint'))),
    text('ghost 按钮悬停', c('--foreground'), onPage(c('--hover'))),
    text('灰色实心 Badge', c('--foreground'), onPage(c('--neutral-fill'))),
    text('destructive 文字 / background', destructive, page),
    text('destructive 按钮', destructive, onPage(alpha(destructive, rest))),
    text('destructive 按钮悬停', destructive, onPage(alpha(destructive, hover))),
    text('Alert text-destructive/90 / card', alpha(destructive, 0.9), c('--card')),
    ui('焦点环 / background', c('--focus-ring'), page),
    ui('焦点环 / 主按钮', c('--focus-ring'), primary),
    // Button link 变体：强调色作文字，页面与卡片上 ≥ 4.5:1
    text('link 文字 / background', c('--primary-text'), page),
    text('link 文字 / card', c('--primary-text'), c('--card')),
    // Input / Textarea：悬停底色上的占位文字
    text('占位文字 / 悬停的输入框', c('--muted-foreground'), onPage(c('--hover'))),
    // 输入框错误态边框 aria-invalid:border-destructive（页面与弹窗上；上游 /50 只有约 2.5:1）
    ui('错误边框 / background', destructive, page),
    ui('错误边框 / surface-5', destructive, c('--surface-5')),
    // Tooltip：反色气泡
    text('Tooltip background / foreground', c('--background'), c('--foreground')),
    // Checkbox 未选中的方框、Switch 关闭态轨道：页面、卡片与弹窗（surface-5）上都要 ≥ 3:1
    ...(['--background', '--card', '--surface-5'] as const).map((surface) =>
      ui(`control-border / ${surface}`, c('--control-border'), c(surface)),
    ),
    // 悬停时复选框所在行 / 开关行的底色
    ui('control-border / 悬停底色', c('--control-border'), onPage(c('--hover'))),
    // Switch：开启态轨道与页面、白色滑块与两种轨道（关闭轨道半透明，分别叠在页面、卡片、弹窗上）
    ui('Switch 开启轨道 / background', c('--fluid-accent'), page),
    ...(['--background', '--card', '--surface-5'] as const).map((surface) =>
      ui(
        `Switch 滑块 / 关闭轨道 on ${surface}`,
        c('--switch-thumb-off'),
        over(c('--control-border'), c(surface)),
      ),
    ),
    ui('Switch 滑块 / 开启轨道', c('--switch-thumb-on'), c('--fluid-accent')),
    // Badge solid：正文色文字在「色值 15% + 页面背景」的淡底上；灰色取 --accent
    text('Badge gray', c('--foreground'), c('--accent')),
    ...Object.entries(badgeColors)
      .filter(([name]) => name !== 'gray')
      .map(([name, value]) =>
        text(
          `Badge ${name}`,
          c('--foreground'),
          parse(`color-mix(in srgb, ${value} 15%, var(--background))`, vars),
        ),
      ),
  ]
}

describe('主题预设', () => {
  const globals = read('globals.css')

  it('四个预设都有样式文件，以 layer(base) 导入；基线变量也在 base 层，brand.css 不分层即可覆盖', () => {
    expect([...UI_PRESETS]).toEqual(['neutral', 'blue', 'violet', 'green'])
    for (const preset of UI_PRESETS) {
      expect(globals).toContain(`@import "./presets/${preset}.css" layer(base);`)
      expect(read(`presets/${preset}.css`)).toContain(`:root[data-preset="${preset}"]`)
      // 预设只换颜色，不改圆角
      expect(read(`presets/${preset}.css`)).not.toMatch(/--radius\s*:/)
    }
    expect(layerOf(globals, ':root')).toBe('base')
    expect(layerOf(globals, '.dark')).toBe('base')
  })

  for (const preset of UI_PRESETS) {
    for (const mode of ['light', 'dark'] as const) {
      it(`${preset} ${mode}：正文 ≥ 4.5:1，焦点环 ≥ 3:1`, () => {
        const css = read(`presets/${preset}.css`)
        const light = block(css, `:root[data-preset="${preset}"]`)
        const dark = block(css, `:root[data-preset="${preset}"].dark`)
        const vars = {
          ...block(globals, ':root'),
          ...light,
          ...(mode === 'dark' ? { ...block(globals, '.dark'), ...dark } : {}),
        }
        // 预设的浅色值在暗色下仍会生效（选择器优先级更高），颜色必须逐项给出暗色值
        if (mode === 'dark') {
          for (const name of Object.keys(light).filter((n) => n !== '--ui-preset')) {
            expect(dark).toHaveProperty(name)
          }
        }
        for (const check of checks(vars, mode)) {
          const ratio = contrast(check.fg, check.bg)
          expect(ratio, `${check.name} = ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(check.min)
        }
      })
    }
  }
})
