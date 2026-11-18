// @vitest-environment happy-dom
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type NotificationPage, NotificationsProvider, useNotifications } from './store.tsx'

const api = vi.hoisted(() => ({
  getNotifications: vi.fn(),
  readNotifications: vi.fn(),
}))
vi.mock('./notifications.functions.ts', () => api)

function pageWith(unread: number): NotificationPage {
  return { rows: [], unread, hasMore: false }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

let state: ReturnType<typeof useNotifications>
function Probe() {
  state = useNotifications()
  return (
    <output data-testid="probe">
      {state.status}:{state.page?.unread ?? '-'}
    </output>
  )
}
const probe = () => screen.getByTestId('probe').textContent

beforeEach(() => {
  vi.useFakeTimers()
  api.getNotifications.mockReset()
  api.readNotifications.mockReset()
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('NotificationsProvider', () => {
  it('首次读取失败进入错误态；有数据后单次轮询失败保留列表与角标', async () => {
    api.getNotifications.mockRejectedValueOnce(new Error('down'))
    render(
      <NotificationsProvider slug="ws">
        <Probe />
      </NotificationsProvider>,
    )
    await act(async () => {})
    expect(probe()).toBe('error:-')

    api.getNotifications.mockResolvedValueOnce(pageWith(2))
    await act(() => state.refresh({ showLoading: true }))
    expect(probe()).toBe('ready:2')

    api.getNotifications.mockRejectedValueOnce(new Error('blip'))
    await act(() => vi.advanceTimersByTimeAsync(30_000))
    expect(api.getNotifications).toHaveBeenCalledTimes(3)
    expect(probe()).toBe('ready:2')
  })

  it('并发读取只采用最后发出的一次（较早的轮询结果不覆盖标为已读后的结果）', async () => {
    const slow = deferred<NotificationPage>()
    api.getNotifications.mockResolvedValueOnce(pageWith(3))
    render(
      <NotificationsProvider slug="ws">
        <Probe />
      </NotificationsProvider>,
    )
    await act(async () => {})
    expect(probe()).toBe('ready:3')

    api.getNotifications.mockReturnValueOnce(slow.promise).mockResolvedValueOnce(pageWith(0))
    api.readNotifications.mockResolvedValueOnce({ updated: 3, link: null })
    let first!: Promise<void>
    await act(async () => {
      first = state.refresh()
      await state.markRead()
    })
    expect(probe()).toBe('ready:0')
    await act(async () => {
      slow.resolve(pageWith(3))
      await first
    })
    expect(probe()).toBe('ready:0')
  })

  it('标签页隐藏时暂停轮询，回到前台立即刷新', async () => {
    api.getNotifications.mockResolvedValue(pageWith(1))
    render(
      <NotificationsProvider slug="ws">
        <Probe />
      </NotificationsProvider>,
    )
    await act(async () => {})
    expect(api.getNotifications).toHaveBeenCalledTimes(1)

    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true)
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'))
      await vi.advanceTimersByTimeAsync(90_000)
    })
    expect(api.getNotifications).toHaveBeenCalledTimes(1)

    hidden.mockReturnValue(false)
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'))
    })
    expect(api.getNotifications).toHaveBeenCalledTimes(2)
    await act(() => vi.advanceTimersByTimeAsync(30_000))
    expect(api.getNotifications).toHaveBeenCalledTimes(3)
    hidden.mockRestore()
  })

  it('「查看全部」的展开请求每次点击都是新请求，只被处理一次', async () => {
    api.getNotifications.mockResolvedValue(pageWith(0))
    render(
      <NotificationsProvider slug="ws">
        <Probe />
      </NotificationsProvider>,
    )
    expect(state.acknowledgeReveal(state.revealRequest)).toBe(false)
    act(() => state.revealCenter())
    const first = state.revealRequest
    expect(state.acknowledgeReveal(first)).toBe(true)
    expect(state.acknowledgeReveal(first)).toBe(false)
    act(() => state.revealCenter())
    expect(state.acknowledgeReveal(state.revealRequest)).toBe(true)
  })
})
