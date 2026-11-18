// @vitest-environment node
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// motion 的完整组件 `motion.*` 自带全部动画能力（约 48 KB gzip）；本包统一用 `m.*` 加 LazyMotion(domAnimation)，
// 交互组件包约小 14 KB。新接入的上游组件照抄 `import { motion }` 时这里失败，按 lib/motion-features.tsx 的说明改写。
const src = new URL('../src/', import.meta.url).pathname

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? files(join(dir, entry.name)) : [join(dir, entry.name)],
  )
}

describe('motion 按需导入', () => {
  const sources = files(src)
    .filter((file) => /\.tsx?$/.test(file))
    .map((file) => ({ file: file.slice(src.length), text: readFileSync(file, 'utf8') }))

  it('不导入完整的 motion 组件；用 m 的文件都包了 MotionFeatures', () => {
    for (const { file, text } of sources) {
      const imports = [...text.matchAll(/import\s*\{([^}]*)\}\s*from\s*'motion\/react'/g)]
        .flatMap((match) => (match[1] ?? '').split(','))
        .map((name) => name.trim())
      expect(imports, file).not.toContain('motion')
      if (imports.includes('m as motion')) {
        expect(text, file).toContain('<MotionFeatures>')
      }
    }
  })
})
