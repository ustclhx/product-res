import { readFileSync } from 'node:fs'
import { CustomFont, ImageResponse } from 'cf-workers-og/node'
import { createElement } from 'react'
import type { Plugin } from 'vite'
import { ogImagePath } from '../src/features/seo/metadata.ts'
import { OgCard } from '../src/features/seo/og-card.ts'
import { publicPages } from '../src/features/seo/pages.ts'

const root = new URL('..', import.meta.url)
const font = new CustomFont(
  'Noto Sans SC',
  readFileSync(new URL('./seo/NotoSansSC-Regular.otf', import.meta.url)),
  { weight: 400 },
)

function pages() {
  // content-collections 输出是 JSON 数组的默认导出；每次读取避免 dev 热更新沿用 ESM 缓存。
  const read = <T>(name: string): T =>
    JSON.parse(
      readFileSync(new URL(`.content-collections/generated/${name}.js`, root), 'utf8')
        .replace(/^\s*export default\s*/, '')
        .trim()
        .replace(/;$/, ''),
    ) as T
  type Content = Parameters<typeof publicPages>[0]
  return publicPages({
    posts: read<Content['posts']>('allPosts'),
    legal: read<Content['legal']>('allLegalPages'),
    docs: read<Content['docs']>('allDocs'),
  })
}

export async function renderOgImage(title: string): Promise<Uint8Array> {
  const response = await ImageResponse.create(createElement(OgCard, { title }), {
    width: 1200,
    height: 630,
    fonts: [font],
  })
  return new Uint8Array(await response.arrayBuffer())
}

/** WASM 与完整字体只在 Node 构建阶段使用，PNG 作为客户端静态资源输出。 */
export function ogImages(): Plugin {
  return {
    name: 'saas:og-images',
    enforce: 'pre',
    applyToEnvironment: (environment) => environment.name === 'client',
    async generateBundle() {
      for (const page of pages()) {
        this.emitFile({
          type: 'asset',
          fileName: decodeURIComponent(ogImagePath(page).slice(1)),
          source: await renderOgImage(page.title),
        })
      }
      this.emitFile({
        type: 'asset',
        fileName: '_headers',
        source: '/og/*\n  Cache-Control: public, max-age=86400\n  X-Robots-Tag: noindex\n',
      })
    },
    configureServer(server) {
      server.middlewares.use(async (request, response, next) => {
        const path = new URL(request.url ?? '/', 'http://localhost').pathname
        if (!path.startsWith('/og/')) return next()
        try {
          const page = pages().find((page) => ogImagePath(page) === path)
          if (!page) {
            response.statusCode = 404
            response.end('Not Found')
            return
          }
          response.setHeader('Content-Type', 'image/png')
          response.end(await renderOgImage(page.title))
        } catch (error) {
          next(error)
        }
      })
    },
  }
}
