import type { ReaderStatus } from '@product-res/ui/reader'
import { ReaderDemo } from './section-reader.tsx'

/**
 * 阅读器整页预览（`/dev/ui/reader?state=…`）：页面自身滚动，供四种状态的桌面 / 移动 × 浅 / 深截图验收。
 * 明暗与语言切换用根布局的悬浮控件，顶栏 actions 插槽留空。
 */
export function ReaderPreviewPage({ status }: { readonly status: ReaderStatus }) {
  return <ReaderDemo status={status} className="min-h-dvh" />
}
