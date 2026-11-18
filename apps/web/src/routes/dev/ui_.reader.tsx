import { createFileRoute, notFound } from '@tanstack/react-router'
import { ReaderPreviewPage } from '../../features/ui-preview/reader-page.tsx'
import {
  READER_STATUSES,
  type ReaderPreviewStatus,
} from '../../features/ui-preview/reader-states.ts'
import { getUiPreviewEnabled } from '../../features/ui-preview/ui-preview.functions.ts'
import { m } from '../../paraglide/messages.js'

// 长文阅读器整页预览（tasks 8.4）：与 /dev/ui 同一开关，只在 UI_PREVIEW=true 时开放，noindex
export const Route = createFileRoute('/dev/ui_/reader')({
  validateSearch: (search: Record<string, unknown>): { state?: ReaderPreviewStatus } =>
    READER_STATUSES.includes(search.state as ReaderPreviewStatus)
      ? { state: search.state as ReaderPreviewStatus }
      : {},
  beforeLoad: async () => {
    if (!(await getUiPreviewEnabled())) throw notFound()
  },
  head: () => ({
    meta: [
      { title: m.ui_preview_reader_title() },
      { name: 'robots', content: 'noindex, nofollow' },
    ],
  }),
  component: ReaderPreviewRoute,
})

function ReaderPreviewRoute() {
  const { state } = Route.useSearch()
  return <ReaderPreviewPage status={state ?? 'ready'} />
}
