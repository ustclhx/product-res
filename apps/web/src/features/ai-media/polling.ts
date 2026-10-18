/** 隐藏时中断请求，重新可见时立即读最新状态；终态只允许手动刷新。 */
export function pollMediaTask<T extends { status: string }>(options: {
  load: (signal: AbortSignal) => Promise<T>
  onTask: (task: T) => void
  onError: (error: unknown) => void
}) {
  let delay = 2000
  let timer: ReturnType<typeof setTimeout> | undefined
  let request: AbortController | undefined
  let stopped = false
  let terminal = false

  function clear() {
    clearTimeout(timer)
    request?.abort()
  }
  async function load() {
    if (stopped || document.hidden) return
    const current = new AbortController()
    request = current
    try {
      const task = await options.load(current.signal)
      if (current.signal.aborted || stopped) return
      terminal = !['queued', 'running'].includes(task.status)
      options.onTask(task)
    } catch (error) {
      if (current.signal.aborted || stopped) return
      options.onError(error)
    }
    if (!stopped && !document.hidden && !terminal) {
      timer = setTimeout(() => void load(), delay)
      delay = Math.min(delay * 2, 10000)
    }
  }
  function refresh() {
    clear()
    delay = 2000
    void load()
  }
  function visibility() {
    clear()
    if (!document.hidden && !terminal) refresh()
  }
  document.addEventListener('visibilitychange', visibility)
  void load()
  return {
    refresh,
    stop() {
      stopped = true
      clear()
      document.removeEventListener('visibilitychange', visibility)
    },
  }
}
