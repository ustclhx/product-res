import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

// 系统开启「减少动态效果」。motion 在首次使用时读取并缓存这一媒体查询，所以单独成文件、在导入组件前设置
vi.hoisted(() => {
  window.matchMedia = ((query: string) => ({
    matches: query.includes('prefers-reduced-motion'),
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as typeof window.matchMedia
})

const {
  ChatMessage,
  ThinkingIndicator,
  ThinkingStep,
  ThinkingSteps,
  ThinkingStepsContent,
  ThinkingStepsHeader,
  ToolCall,
} = await import('../src/chat.ts')

const { frame } = await import('./animation.ts')

Reflect.deleteProperty(Element.prototype, 'animate')
afterEach(() => cleanup())

describe('对话组件 · 减少动态效果', () => {
  it('思考中的三点是 CSS 动画，减少动态效果时由 motion-reduce:animate-none 静止；推理面板高度直接跳到终值', async () => {
    render(
      <>
        <ThinkingIndicator label="正在思考" />
        <ThinkingSteps>
          <ThinkingStepsHeader busy>思考中…</ThinkingStepsHeader>
          <ThinkingStepsContent>
            <ThinkingStep>推理</ThinkingStep>
          </ThinkingStepsContent>
        </ThinkingSteps>
      </>,
    )
    const dots = document.querySelectorAll('[data-thinking-dots] > span')
    expect(dots).toHaveLength(6)
    for (const dot of dots) {
      const cls = (dot as HTMLElement).className.split(/\s+/)
      expect(cls).toEqual(
        expect.arrayContaining(['animate-chat-dot', 'motion-reduce:animate-none']),
      )
      // 不是 motion 元素：没有内联的透明度动画
      expect((dot as HTMLElement).style.opacity).toBe('')
    }
    expect(screen.getByText('正在思考')).toBeTruthy()

    // 展开推理：高度动画时长为 0，下一帧就不再是 0 高（不用逐帧等待弹簧）
    const trigger = screen.getByRole('button', { name: '思考中…' })
    fireEvent.click(trigger)
    const panel = trigger.nextElementSibling?.firstElementChild as HTMLElement
    await frame()
    expect(panel.style.height).not.toBe('0px')
  })

  it('重试中与执行中的转圈在 CSS 中静止，流式光标由 globals.css 的媒体查询静止', () => {
    const { container } = render(
      <>
        <ChatMessage from="assistant" status="retrying" statusLabel="重试中" entrance={false}>
          正文
        </ChatMessage>
        <ToolCall
          name="工具"
          state="running"
          labels={{ pending: '准备中', running: '执行中', done: '已完成', error: '出错' }}
        />
      </>,
    )
    const spinners = container.querySelectorAll('.animate-spin')
    expect(spinners).toHaveLength(2)
    for (const spinner of spinners)
      expect(spinner.getAttribute('class')).toContain('motion-reduce:animate-none')
  })
})
