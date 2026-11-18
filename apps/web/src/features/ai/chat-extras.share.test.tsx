import type { MessageFeedbackProps } from '@product-res/ui'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { MessageFeedback } from './chat-extras.tsx'
import { FEEDBACK_SHARED_PRIOR_MESSAGES } from './feedback.ts'

// 对话页的评分接线必须传入共享对话勾选项的文案（add-subject-chat tasks.md 10.3）；
// 勾选交互在 packages/ui/test/business.test.tsx 与 e2e/chat-business-ui.spec.ts 覆盖。
// 静态导入（vi.mock 会提升到导入之前），加载 @product-res/ui 的耗时计入收集阶段而不是用例超时。

const captured: MessageFeedbackProps[] = []
vi.mock('@product-res/ui', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@product-res/ui')>()),
  MessageFeedback: (props: MessageFeedbackProps) => {
    captured.push(props)
    return null
  },
}))

describe('MessageFeedback wiring', () => {
  it('passes share labels naming the shared range and maps consent to a boolean', async () => {
    const onChange = vi.fn(async () => {})
    renderToStaticMarkup(<MessageFeedback messageId="m" value={null} onChange={onChange} />)
    const props = captured.at(-1)
    expect(props?.shareLabels?.label).toMatch(/Share this reply|共享这条回复/)
    expect(props?.shareLabels?.description).toContain(String(FEEDBACK_SHARED_PRIOR_MESSAGES))
    // 组件回调未带同意时按不同意处理
    await props?.onChange({ rating: 'down', comment: null, reason: null })
    expect(onChange).toHaveBeenLastCalledWith({
      rating: 'down',
      comment: null,
      reason: null,
      shareConversation: false,
    })
    await props?.onChange({ rating: 'down', comment: null, shareConversation: true })
    expect(onChange).toHaveBeenLastCalledWith({
      rating: 'down',
      comment: null,
      reason: null,
      shareConversation: true,
    })
  })
})
