import { createFileRoute } from '@tanstack/react-router'

// /dev/ui 分享卡片预览图；与预览页同一开关 UI_PREVIEW，生产 404（features/share-cards/preview.server.ts）。
export const Route = createFileRoute('/api/dev/share-card-preview')({
  server: {
    handlers: {
      GET: async ({ request }) =>
        (
          await import('../../../features/share-cards/preview.server.ts')
        ).handleShareCardPreviewRequest(request),
    },
  },
})
