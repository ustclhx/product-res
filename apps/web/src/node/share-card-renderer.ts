// Node 渲染器（自托管与构建期共用）：字体从本地文件读取，satori / resvg 经 cf-workers-og 的 Node 入口。
// 自托管由 runtime.ts 以动态 import() 加载，构建期由 scripts/og-images.ts 直接使用。
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { ImageResponse } from 'cf-workers-og/node'
import {
  CJK_FONT_FILE,
  createShareCardRenderer,
  LATIN_FONT_FILES,
  type ShareCardRenderer,
} from '../features/share-cards/renderer.ts'

async function readArrayBuffer(path: string): Promise<ArrayBuffer> {
  const data = await readFile(path)
  // 传入独立的 ArrayBuffer：cf-workers-og 遇到视图会每次复制一份
  return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer
}

const renderers = new Map<string, ShareCardRenderer>()

/** `fontDir` 为发布后的 `public/fonts/share-card` 目录；同一目录在进程内复用一个渲染器。 */
export function createNodeShareCardRenderer(fontDir: string): ShareCardRenderer {
  const existing = renderers.get(fontDir)
  if (existing) return existing
  const renderer = createShareCardRenderer({
    engine: (element, options) => ImageResponse.create(element, options),
    loadLatinFonts: () =>
      Promise.all(
        LATIN_FONT_FILES.map(async ({ file, weight }) => ({
          name: 'Inter',
          data: await readArrayBuffer(join(fontDir, file)),
          weight,
          style: 'normal' as const,
        })),
      ),
    loadCjkFont: () => readArrayBuffer(join(fontDir, CJK_FONT_FILE)),
    // 文件名已在登记时校验为不含路径分隔符，只能读取字体目录内的文件。
    loadProjectFont: (file) => readArrayBuffer(join(fontDir, file)),
  })
  renderers.set(fontDir, renderer)
  return renderer
}

/**
 * 自托管产物目录为 `server/index.mjs` 与 `public/`；按入口位置、工作目录依次查找。
 * 可用 SHARE_CARD_FONT_DIR 显式指定。
 */
export function nodeShareCardFontDir(env: NodeJS.ProcessEnv = process.env): string {
  const candidates = [
    env.SHARE_CARD_FONT_DIR,
    process.argv[1] && resolve(dirname(process.argv[1]), '../public/fonts/share-card'),
    resolve('public/fonts/share-card'),
    resolve('.output/public/fonts/share-card'),
  ].filter((path): path is string => Boolean(path))
  return (
    candidates.find((path) => existsSync(join(path, CJK_FONT_FILE))) ?? (candidates[0] as string)
  )
}
