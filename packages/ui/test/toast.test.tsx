import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { renderToString } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { resetToastsForTesting, Toaster, toast } from '../src/components/toast.tsx'
import { TOAST_EXIT_MS } from '../src/components/toast-store.ts'
import { exitFallbackMs, spring } from '../src/lib/springs.ts'

Element.prototype.hasPointerCapture ??= () => false
Element.prototype.setPointerCapture ??= () => {}
Element.prototype.releasePointerCapture ??= () => {}
Reflect.deleteProperty(Element.prototype, 'animate')

// store 是模块级单例：每个用例后卸载并清空
afterEach(() => {
  cleanup()
  act(() => resetToastsForTesting())
})

const labels = { region: '通知（{hotkey}）', announcement: '通知', close: '关闭' }
const wait = (ms: number) => act(() => new Promise((resolve) => setTimeout(resolve, ms)))
const frame = () => act(() => new Promise((resolve) => requestAnimationFrame(() => resolve(null))))

function mount(props: Partial<Parameters<typeof Toaster>[0]> = {}) {
  return render(<Toaster labels={labels} {...props} />)
}

/** 通知本体：Radix 渲染为视口 <ol> 下的 <li> */
const items = () => Array.from(document.querySelectorAll('ol > li')) as HTMLElement[]

describe('Toast', () => {
  it('命令式 toast 出现在命名区域中，并经 role="status" / aria-live 播报', async () => {
    mount()
    const region = screen.getByRole('region', { name: '通知（F8）' })
    act(() => {
      toast('已保存', { description: '修改已生效' })
    })
    expect(region.textContent).toContain('已保存')
    expect(region.textContent).toContain('修改已生效')
    expect(screen.getByRole('button', { name: '关闭' })).toBeTruthy()
    // Radix 在下两帧写入播报文字，前缀为 labels.announcement，关闭按钮不播报
    await frame()
    await frame()
    await wait(0)
    const status = screen.getByRole('status')
    expect(status.getAttribute('aria-live')).toBe('assertive')
    expect(status.textContent).toContain('通知')
    expect(status.textContent).toContain('已保存')
    expect(status.textContent).not.toContain('关闭')
  })

  it('success / error 变体', () => {
    mount()
    act(() => {
      toast.success('支付成功')
      toast.error('支付失败')
    })
    const [ok, bad] = items()
    expect(ok?.dataset.variant).toBe('success')
    expect(ok?.querySelector('svg.text-success')).toBeTruthy()
    expect(bad?.dataset.variant).toBe('error')
    expect(
      bad?.querySelector(
        'div.text-destructive, h2.text-destructive, [class*="font-semibold"].text-destructive',
      )?.textContent,
    ).toBe('支付失败')
    expect(bad?.querySelector('svg.text-destructive')).toBeTruthy()
  })

  it('action 回调被调用并关闭通知；preventDefault 时保持打开', async () => {
    mount()
    const onUndo = vi.fn()
    const onDismiss = vi.fn()
    act(() => {
      toast('已删除', { action: { label: '撤销', onClick: onUndo }, onDismiss })
    })
    fireEvent.click(screen.getByRole('button', { name: '撤销' }))
    expect(onUndo).toHaveBeenCalledTimes(1)
    expect(onDismiss).toHaveBeenCalledTimes(1)
    expect(items()[0]?.dataset.state).toBe('closed')
    await wait(400)
    expect(items()).toHaveLength(0)

    act(() => {
      toast('再试', { action: { label: '重试', onClick: (e) => e.preventDefault() } })
    })
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    expect(items()[0]?.dataset.state).toBe('open')
  })

  it('关闭按钮关闭通知，退场后移除', async () => {
    mount()
    act(() => {
      toast('一条通知')
    })
    fireEvent.click(screen.getByRole('button', { name: '关闭' }))
    expect(items()[0]?.dataset.state).toBe('closed')
    expect(items()[0]?.hasAttribute('inert')).toBe(true)
    await wait(400)
    expect(items()).toHaveLength(0)
  })

  it('toast.dismiss(id) 只关闭指定一条，省略 id 关闭全部；同 id 再次调用为更新', async () => {
    mount()
    let first = ''
    act(() => {
      first = toast('第一条')
      toast('第二条')
    })
    act(() => toast.dismiss(first))
    expect(items().map((li) => li.dataset.state)).toEqual(['closed', 'open'])
    act(() => {
      toast('第二条已更新', { id: 'fixed' })
      toast('第二条再次更新', { id: 'fixed' })
    })
    expect(screen.getAllByText(/第二条/)).toHaveLength(2)
    act(() => toast.dismiss())
    await wait(400)
    expect(items()).toHaveLength(0)
  })

  it('duration 到期自动消失（Infinity 不消失）', async () => {
    mount()
    const onDismiss = vi.fn()
    act(() => {
      toast('短暂', { duration: 50, onDismiss })
      toast('常驻', { duration: Number.POSITIVE_INFINITY })
    })
    await wait(80)
    expect(onDismiss).toHaveBeenCalledWith(expect.stringMatching(/^toast-/))
    await wait(400)
    expect(items()).toHaveLength(1)
    expect(items()[0]?.textContent).toContain('常驻')
  })

  it('Esc 关闭聚焦中的通知', () => {
    mount()
    act(() => {
      toast('按 Esc 关闭')
    })
    const li = items()[0] as HTMLElement
    act(() => li.focus())
    fireEvent.keyDown(li, { key: 'Escape' })
    expect(li.dataset.state).toBe('closed')
  })

  it('F8 聚焦视口', () => {
    mount()
    act(() => {
      toast('热键')
    })
    fireEvent.keyDown(document, { key: 'F8', code: 'F8' })
    expect(document.activeElement?.tagName).toBe('OL')
  })

  it('超过 visibleToasts 时最早的一条直接关闭，之后不会复活', async () => {
    mount({ visibleToasts: 2 })
    const onDismiss = vi.fn()
    let cId = ''
    act(() => {
      toast('A', { onDismiss })
      toast('B')
      cId = toast('C')
    })
    // A 立即进入退场（inert），退场结束后移除
    expect(onDismiss).toHaveBeenCalledWith(expect.any(String))
    await wait(400)
    expect(items().map((li) => li.textContent?.slice(0, 1))).toEqual(['B', 'C'])
    // 再关闭一条后 A 不会补回（旧实现会让排队的 A 重新出现）
    act(() => toast.dismiss(cId))
    await wait(400)
    expect(items().map((li) => li.textContent?.slice(0, 1))).toEqual(['B'])
  })

  it('error 变体带 circle-alert 图标；store 的退场时长与 spring.moderate 一致', () => {
    mount()
    act(() => {
      toast.error('失败')
    })
    const li = items()[0] as HTMLElement
    expect(li.querySelector('svg.text-destructive')).not.toBeNull()
    expect(TOAST_EXIT_MS).toBe(exitFallbackMs(spring.moderate))
  })

  it('视口宽度不超过 100vw - 2rem（360px 窄屏不溢出）', () => {
    mount()
    const ol = document.querySelector('ol') as HTMLElement
    expect(ol.className).toContain('w-[min(24rem,calc(100vw-2rem))]')
  })

  it('无 UiRoot 时进场动画推进（m.* 在 MotionFeatures 之下）', async () => {
    mount()
    act(() => {
      toast('动画')
    })
    const li = items()[0] as HTMLElement
    await frame()
    // 正常动效下从 translateY(8px) scale(0.97) 起步
    expect(li.style.opacity).not.toBe('1')
    expect(li.style.transform).toMatch(/translateY\([\d.]+px\)/)
    await wait(500)
    expect(li.style.opacity).toBe('1')
    expect(li.style.transform).toBe('none')
  })
})

describe('Toast SSR', () => {
  it('服务端渲染不报错、不输出 toast', () => {
    toast('服务端不应出现')
    const html = renderToString(<Toaster labels={labels} />)
    expect(html).not.toContain('服务端不应出现')
    expect(html).toContain('<ol')
  })
})
