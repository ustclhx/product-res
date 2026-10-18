import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { pollMediaTask } from './polling.ts'

let visible: EventTarget & { hidden: boolean }
beforeEach(() => {
  vi.useFakeTimers()
  visible = Object.assign(new EventTarget(), { hidden: false })
  vi.stubGlobal('document', visible)
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('媒体详情轮询', () => {
  it('以 2、4、8、10 秒退避，成功、失败和取消终态都停止请求', async () => {
    for (const terminal of ['succeeded', 'failed', 'canceled']) {
      const times: number[] = []
      const start = Date.now()
      const load = vi.fn(async () => {
        times.push(Date.now() - start)
        return { status: times.length < 6 ? 'running' : terminal }
      })
      const onTask = vi.fn()
      const poll = pollMediaTask({ load, onTask, onError: vi.fn() })
      await vi.advanceTimersByTimeAsync(34000)
      expect(times).toEqual([0, 2000, 6000, 14000, 24000, 34000])
      expect(onTask).toHaveBeenLastCalledWith({ status: terminal })
      await vi.advanceTimersByTimeAsync(60000)
      expect(load).toHaveBeenCalledTimes(6)
      poll.stop()
    }
  })

  it('隐藏时暂停并中断在途请求，恢复立即刷新，卸载后不更新', async () => {
    let finish: (task: { status: string }) => void = () => {}
    const signals: AbortSignal[] = []
    const load = vi.fn((signal: AbortSignal) => {
      signals.push(signal)
      return new Promise<{ status: string }>((resolve) => {
        finish = resolve
      })
    })
    const onTask = vi.fn()
    const poll = pollMediaTask({ load, onTask, onError: vi.fn() })
    visible.hidden = true
    visible.dispatchEvent(new Event('visibilitychange'))
    expect(signals[0]?.aborted).toBe(true)
    finish({ status: 'succeeded' })
    await vi.advanceTimersByTimeAsync(60000)
    expect(onTask).not.toHaveBeenCalled()
    expect(load).toHaveBeenCalledTimes(1)
    visible.hidden = false
    visible.dispatchEvent(new Event('visibilitychange'))
    expect(load).toHaveBeenCalledTimes(2)
    poll.stop()
    expect(signals[1]?.aborted).toBe(true)
    finish({ status: 'running' })
    await vi.advanceTimersByTimeAsync(60000)
    expect(onTask).not.toHaveBeenCalled()
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('请求失败可恢复，手动刷新中断旧请求且终态后切回页面不重启', async () => {
    const error = new Error('offline')
    const load = vi
      .fn()
      .mockRejectedValueOnce(error)
      .mockResolvedValueOnce({ status: 'running' })
      .mockResolvedValue({ status: 'succeeded' })
    const onError = vi.fn()
    const onTask = vi.fn()
    const poll = pollMediaTask({ load, onTask, onError })
    await vi.advanceTimersByTimeAsync(2000)
    expect(onError).toHaveBeenCalledWith(error)
    expect(onTask).toHaveBeenCalledWith({ status: 'running' })
    poll.refresh()
    await vi.advanceTimersByTimeAsync(0)
    expect(onTask).toHaveBeenLastCalledWith({ status: 'succeeded' })
    visible.hidden = true
    visible.dispatchEvent(new Event('visibilitychange'))
    visible.hidden = false
    visible.dispatchEvent(new Event('visibilitychange'))
    await vi.advanceTimersByTimeAsync(30000)
    expect(load).toHaveBeenCalledTimes(3)
    poll.stop()
  })
})
