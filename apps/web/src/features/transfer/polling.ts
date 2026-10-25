import { useEffect, useRef } from 'react'

/** 进行中的流转自动刷新：active 为真时每 intervalMs 调用一次 refresh（上一轮未完成时跳过） */
export function usePolling(active: boolean, refresh: () => Promise<void>, intervalMs = 3000) {
  const latest = useRef(refresh)
  latest.current = refresh
  useEffect(() => {
    if (!active) return
    let running = false
    const timer = window.setInterval(() => {
      if (running || document.visibilityState === 'hidden') return
      running = true
      void latest.current().finally(() => {
        running = false
      })
    }, intervalMs)
    return () => window.clearInterval(timer)
  }, [active, intervalMs])
}
