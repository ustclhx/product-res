// @vitest-environment node
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { shareCardThemes } from '../src/share-card-theme.ts'

// 设计中的 tokens.css 在当前组件库中由 globals.css 承载。
const css = readFileSync(new URL('../src/styles/globals.css', import.meta.url), 'utf8').replace(
  /\/\*[\s\S]*?\*\//g,
  '',
)

function declarations(selector: ':root' | '.dark'): Record<string, string> {
  const start = css.indexOf(`${selector} {`)
  const block = css.slice(start, css.indexOf('}', start))
  return Object.fromEntries(
    [...block.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map((match) => [
      match[1] as string,
      (match[2] as string).trim(),
    ]),
  )
}

const light = declarations(':root')

function resolve(name: string, vars: Record<string, string>): string {
  const value = vars[name]
  if (value === undefined) throw new Error(`缺少基线 token ${name}`)
  return value.replace(/var\((--[\w-]+)\)/g, (_, reference: string) => resolve(reference, vars))
}

describe('分享卡片主题基线', () => {
  for (const mode of ['light', 'dark'] as const) {
    it(`${mode} 的颜色与已解析的 CSS 基线一致`, () => {
      const vars = { ...light, ...(mode === 'dark' ? declarations('.dark') : {}) }
      const theme = shareCardThemes[mode]
      for (const [field, token] of [
        ['background', '--background'],
        ['foreground', '--foreground'],
        ['muted', '--muted'],
        ['mutedForeground', '--muted-foreground'],
        ['secondary', '--secondary'],
        ['primary', '--primary'],
        ['primaryText', '--primary-text'],
        ['primaryForeground', '--primary-foreground'],
        ['brandAccent', '--fluid-accent'],
      ] as const) {
        expect(theme[field], token).toBe(resolve(token, vars))
      }

      // 与透明色混合只改变不透明度，保留前景色通道；渲染器无需支持 color-mix。
      const border = /^color-mix\(in oklab, #([\da-f]{6}) (\d+)%, transparent\)$/.exec(
        resolve('--border', vars),
      )
      if (!border) throw new Error('基线边框表达式已改变，请更新分享卡片的解析值')
      const hex = Number.parseInt(border[1] as string, 16)
      const channels = [hex >> 16, (hex >> 8) & 255, hex & 255]
      expect(theme.border).toBe(`rgba(${channels.join(', ')}, ${Number(border[2]) / 100})`)
    })
  }

  it('圆角与六角色的两档字号使用 CSS 基线的 px 值', () => {
    const radius = resolve('--radius', light)
    expect(radius).toMatch(/^[\d.]+rem$/)
    for (const theme of Object.values(shareCardThemes)) {
      expect(theme.radius).toBe(Number.parseFloat(radius) * 16)
      for (const [role, steps] of Object.entries(theme.fontSize)) {
        expect(`${steps.default}px`).toBe(resolve(`--fs-${role}`, light))
        expect(`${steps.compact}px`).toBe(resolve(`--fs-${role}-compact`, light))
      }
    }
  })
})
