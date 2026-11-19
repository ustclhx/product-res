// @vitest-environment happy-dom
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AnnouncementBanner } from './settings-announcement-banner.tsx'

const api = vi.hoisted(() => ({ getAnnouncement: vi.fn() }))
vi.mock('./settings-announcement.functions.ts', () => api)

beforeEach(() => {
  vi.useFakeTimers()
  api.getAnnouncement.mockReset()
  api.getAnnouncement.mockResolvedValue('维护通知')
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('AnnouncementBanner', () => {
  it('前台每分钟刷新；标签页隐藏时不访问服务端，回到前台立即读取一次', async () => {
    render(<AnnouncementBanner initial="" />)
    expect(api.getAnnouncement).not.toHaveBeenCalled()

    await act(() => vi.advanceTimersByTimeAsync(60_000))
    expect(api.getAnnouncement).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('status').textContent).toBe('维护通知')

    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true)
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'))
      await vi.advanceTimersByTimeAsync(10 * 60_000)
    })
    expect(api.getAnnouncement).toHaveBeenCalledTimes(1)

    hidden.mockReturnValue(false)
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'))
    })
    expect(api.getAnnouncement).toHaveBeenCalledTimes(2)
    await act(() => vi.advanceTimersByTimeAsync(60_000))
    expect(api.getAnnouncement).toHaveBeenCalledTimes(3)
    hidden.mockRestore()
  })

  it('在后台打开的标签页挂载后不启动轮询', async () => {
    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true)
    render(<AnnouncementBanner initial="已有公告" />)
    await act(() => vi.advanceTimersByTimeAsync(5 * 60_000))
    expect(api.getAnnouncement).not.toHaveBeenCalled()
    expect(screen.getByRole('status').textContent).toBe('已有公告')
    hidden.mockRestore()
  })
})
