import { createFileRoute, notFound } from '@tanstack/react-router'
import { UiPreviewPage } from '../../features/ui-preview/preview-page.tsx'
import { getUiPreviewEnabled } from '../../features/ui-preview/ui-preview.functions.ts'
import { m } from '../../paraglide/messages.js'

// 组件预览页（openspec add-ui-design-system design D6）：beforeLoad 经 server function 在服务端读取
// UI_PREVIEW，未设为 true（production）时 404。不在预渲染范围（features/marketing/prerender.ts）与
// sitemap（features/seo/pages.ts）中，并声明 noindex。
export const Route = createFileRoute('/dev/ui')({
  beforeLoad: async () => {
    if (!(await getUiPreviewEnabled())) throw notFound()
  },
  head: () => ({
    meta: [{ title: m.ui_preview_title() }, { name: 'robots', content: 'noindex, nofollow' }],
  }),
  component: UiPreviewPage,
})
