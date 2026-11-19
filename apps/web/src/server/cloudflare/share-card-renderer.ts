// Workers 渲染器：由 server.ts 的 WebRuntime 以动态 import() 加载，satori / resvg WASM 与西文字体
// 只在分享卡片首次渲染时进入隔离区。模块顶层不调用随机 API（动态导入的模块求值仍属全局作用域）。
import { ImageResponse } from 'cf-workers-og'
import inter400 from '../../../public/fonts/share-card/inter-latin-400-normal.woff.bin'
import inter600 from '../../../public/fonts/share-card/inter-latin-600-normal.woff.bin'
import {
  CJK_FONT_FILE,
  createShareCardRenderer,
  type ShareCardRenderer,
} from '../../features/share-cards/renderer.ts'

/** CJK 字体作为静态资源发布（/fonts/share-card/），不打进 Worker 包。 */
export const CJK_FONT_PATH = `/fonts/share-card/${CJK_FONT_FILE}`

/**
 * 线上 ASSETS 只按路径匹配静态资源，主机名不参与。开发时 ASSETS 转发给 vite dev，
 * 其主机白名单会以 403 拒绝未知主机，所以仅开发时用 localhost。
 */
const ASSETS_ORIGIN = import.meta.env.DEV ? 'http://localhost' : 'https://assets.local'

let renderer: ShareCardRenderer | undefined

/** 同一隔离区复用一个渲染器，字体与并发计数随之共享。 */
export function workersShareCardRenderer(assets: Fetcher): ShareCardRenderer {
  renderer ??= createShareCardRenderer({
    engine: (element, options) => ImageResponse.create(element, options),
    loadLatinFonts: () => [
      { name: 'Inter', data: inter400, weight: 400, style: 'normal' },
      { name: 'Inter', data: inter600, weight: 600, style: 'normal' },
    ],
    loadCjkFont: () => fetchFont(assets, CJK_FONT_PATH),
    // 项目字体同样作为静态资源发布，不打进 Worker 包；文件名已在登记时校验为不含路径分隔符。
    loadProjectFont: (file) => fetchFont(assets, `/fonts/share-card/${file}`),
  })
  return renderer
}

async function fetchFont(assets: Fetcher, path: string): Promise<ArrayBuffer> {
  const response = await assets.fetch(new Request(`${ASSETS_ORIGIN}${path}`))
  if (!response.ok) {
    await response.body?.cancel()
    throw new Error(`Share card font unavailable: ${path} ${response.status}`)
  }
  return response.arrayBuffer()
}
