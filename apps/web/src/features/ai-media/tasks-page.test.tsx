import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { m } from '../../paraglide/messages.js'
import type { MediaCancelPreview } from './tasks-client.ts'
import { CancelConfirmation, cancelPreviewText } from './tasks-page.tsx'

const base: MediaCancelPreview = {
  taskId: '00000000-0000-4000-8000-000000000001',
  cancelable: true,
  started: false,
  charged: false,
  credits: 0,
  freeStartedRemaining: 1,
}
const render = (preview: MediaCancelPreview) =>
  renderToString(
    <CancelConfirmation preview={preview} busy={false} onConfirm={() => {}} onDismiss={() => {}} />,
  )
// renderToString 会转义引号等字符，与组件输出保持同一转义口径。
const escaped = (text: string) =>
  text.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll("'", '&#x27;')

describe('媒体取消确认说明', () => {
  it('排队中的任务说明免费取消且不占用免费次数', () => {
    const html = render(base)
    expect(cancelPreviewText(base)).toBe(m.media_tasks_cancel_unstarted())
    expect(html).toContain(escaped(m.media_tasks_cancel_unstarted()))
    expect(html).toContain('role="alertdialog"')
    expect(html).toContain(escaped(m.media_tasks_cancel_confirm()))
    expect(html).toContain(escaped(m.media_tasks_cancel_keep()))
  })

  it('已开始且仍有免费次数时说明这是唯一一次免费机会', () => {
    const preview = { ...base, started: true }
    expect(cancelPreviewText(preview)).toBe(m.media_tasks_cancel_free_started())
    expect(render(preview)).toContain(escaped(m.media_tasks_cancel_free_started()))
  })

  it('免费次数用完时说明将按全价扣除的积分', () => {
    const preview = { ...base, started: true, charged: true, credits: 12, freeStartedRemaining: 0 }
    const text = cancelPreviewText(preview)
    expect(text).toBe(m.media_tasks_cancel_charged({ credits: 12 }))
    expect(text).toContain('12')
    expect(render(preview)).toContain(escaped(text))
    expect(
      new Set([text, m.media_tasks_cancel_unstarted(), m.media_tasks_cancel_free_started()]).size,
    ).toBe(3)
  })
})
