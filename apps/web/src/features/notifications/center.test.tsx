// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { m } from '../../paraglide/messages.js'
import { NotificationCenter } from './center.tsx'
import { type NotificationPage, NotificationsContext, type NotificationsState } from './store.tsx'

const router = vi.hoisted(() => ({ navigate: vi.fn(), hash: '' }))
vi.mock('@tanstack/react-router', () => ({
  useRouter: () => ({ navigate: router.navigate }),
  useLocation: ({ select }: { select: (location: { hash: string }) => unknown }) =>
    select({ hash: router.hash }),
}))
vi.mock('./notifications.functions.ts', () => ({ getNotifications: vi.fn() }))

Element.prototype.scrollIntoView = vi.fn()

const ROW = {
  id: '01890000-0000-7000-8000-000000000001',
  userId: 'u',
  workspaceId: 'w',
  type: 'test',
  title: 'Report ready',
  body: null,
  link: null,
  readAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
}
const PAGE: NotificationPage = { rows: [ROW], unread: 1, hasMore: false }

function state(overrides: Partial<NotificationsState> = {}): NotificationsState {
  return {
    slug: 'ws',
    status: 'ready',
    page: PAGE,
    refresh: vi.fn(async () => {}),
    markRead: vi.fn(async () => ({ link: null })),
    revealCenter: vi.fn(),
    revealRequest: 0,
    acknowledgeReveal: vi.fn((request: number) => request > 0),
    ...overrides,
  }
}

function renderCenter(value: NotificationsState) {
  const view = render(
    <NotificationsContext.Provider value={value}>
      <NotificationCenter />
    </NotificationsContext.Provider>,
  )
  return {
    ...view,
    update: (next: NotificationsState) =>
      view.rerender(
        <NotificationsContext.Provider value={next}>
          <NotificationCenter />
        </NotificationsContext.Provider>,
      ),
  }
}

beforeEach(() => {
  router.hash = ''
  router.navigate.mockReset()
})
afterEach(() => cleanup())

describe('NotificationCenter', () => {
  it('第一页「标为已读」失败一次后重试成功，错误提示消失', async () => {
    const markRead = vi
      .fn()
      .mockRejectedValueOnce(new Error('down'))
      .mockResolvedValueOnce({ link: null })
    renderCenter(state({ markRead }))
    const markAll = screen.getByRole('button', { name: m.notifications_mark_all_read() })

    await act(async () => fireEvent.click(markAll))
    expect(screen.getByRole('alert').textContent).toBe(m.notifications_action_failed())

    await act(async () => fireEvent.click(markAll))
    expect(markRead).toHaveBeenCalledTimes(2)
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('失败后第一页刷新成功（轮询）时清掉错误提示', async () => {
    const value = state({ markRead: vi.fn().mockRejectedValueOnce(new Error('down')) })
    const { update } = renderCenter(value)
    await act(async () =>
      fireEvent.click(screen.getByRole('button', { name: m.notifications_mark_all_read() })),
    )
    expect(screen.getByRole('alert')).toBeTruthy()
    update({ ...value, page: { ...PAGE } })
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('「查看全部」的展开请求（含已在首页时再次请求）展开通知区并滚动', async () => {
    const value = state()
    const { container, update } = renderCenter(value)
    const details = container.querySelector('details') as HTMLDetailsElement
    expect(details.open).toBe(false)
    update({ ...value, revealRequest: 1 })
    expect(details.open).toBe(true)
    await act(() => new Promise((resolve) => requestAnimationFrame(resolve)))
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled()

    // 用户折起后再次请求，再次展开
    details.open = false
    fireEvent(details, new Event('toggle'))
    expect(details.open).toBe(false)
    update({ ...value, revealRequest: 2 })
    expect(details.open).toBe(true)
  })

  it('已加载且为空时挂载（地址带 #notifications），第一条通知到达后不自动展开', () => {
    router.hash = 'notifications'
    const empty = state({ page: { rows: [], unread: 0, hasMore: false } })
    const view = render(
      <NotificationsContext.Provider value={empty}>
        <NotificationCenter hideWhenEmpty />
      </NotificationsContext.Provider>,
    )
    expect(view.container.querySelector('details')).toBeNull()
    view.rerender(
      <NotificationsContext.Provider value={{ ...empty, page: PAGE }}>
        <NotificationCenter hideWhenEmpty />
      </NotificationsContext.Provider>,
    )
    expect((view.container.querySelector('details') as HTMLDetailsElement).open).toBe(false)
  })
})
