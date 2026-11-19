import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { MessageFeedback, SuggestionChips } from './chat-extras.tsx'

// add-subject-chat tasks.md 6.1 的接口，展示组件由 add-ui-design-system 8.6 替换（props 保持不变）；
// 交互（撤销、文字反馈、回滚）在 packages/ui/test/business.test.tsx 与 e2e/chat-business-ui.spec.ts 覆盖。

describe('SuggestionChips', () => {
  it('renders one button per suggestion and nothing when empty', () => {
    const html = renderToStaticMarkup(
      <SuggestionChips suggestions={['Summarize it', 'What next?']} onSelect={() => {}} />,
    )
    expect(html.match(/<button/g)).toHaveLength(2)
    expect(html).toContain('Summarize it')
    expect(renderToStaticMarkup(<SuggestionChips suggestions={[]} onSelect={() => {}} />)).toBe('')
  })
})

describe('MessageFeedback', () => {
  it('marks the current rating as pressed; a rated reply offers editing written feedback', () => {
    const html = renderToStaticMarkup(
      <MessageFeedback
        messageId="m"
        value={{ rating: 'down', comment: null, reason: 'incomplete' }}
        onChange={async () => {}}
      />,
    )
    expect(html.match(/aria-pressed="true"/g)).toHaveLength(1)
    expect(html).toMatch(/aria-label="(Not helpful|没帮助)" aria-pressed="true"/)
    expect(html).toMatch(/Edit feedback|修改反馈/)
    const empty = renderToStaticMarkup(
      <MessageFeedback messageId="m" value={null} onChange={async () => {}} />,
    )
    expect(empty).not.toMatch(/Edit feedback|修改反馈/)
    expect(empty).toMatch(/role="group" aria-label="(Rate this reply|评价这条回复)"/)
  })
})
