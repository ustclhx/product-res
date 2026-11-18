import { createFileRoute } from '@tanstack/react-router'

/**
 * 分享卡片图片 `/share-card/<type>/<token>.png?v=<version>-<digest8>`（openspec add-og-images design 第 3 条）。
 * 处理模块与渲染器都按需加载，首页与其他路由的闭包不含 satori / resvg / 字体。
 */
export const Route = createFileRoute('/share-card/$type/$file')({
  server: {
    handlers: {
      GET: async ({ request, params }) =>
        (await import('../features/share-cards/image.server.ts')).handleShareCardImageRequest(
          request,
          params,
        ),
    },
  },
})
