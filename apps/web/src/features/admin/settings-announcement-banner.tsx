import { useEffect, useState } from 'react'
import { m } from '../../paraglide/messages.js'
import { getAnnouncement } from './settings-announcement.functions.ts'

export const ANNOUNCEMENT_POLL_INTERVAL_MS = 60_000

/**
 * 站点公告横幅，挂在根布局，所有页面都会渲染。标签页隐藏时暂停轮询、回到前台立即读取一次：
 * 轮询间隔与设置 KV 缓存 TTL 同为 60 秒，几乎每次都会穿透到数据库，遗忘在后台的标签页
 * 会让 Neon 永远无法缩容到零（见 production-neon §4 成本基线）。
 */
export function AnnouncementBanner({ initial }: { initial: string }) {
  const [announcement, setAnnouncement] = useState(initial)
  useEffect(() => {
    setAnnouncement(initial)
    let active = true
    let timer: ReturnType<typeof setInterval> | undefined
    const refresh = () => {
      void getAnnouncement()
        .then((value) => {
          if (active) setAnnouncement(value)
        })
        .catch(() => {
          // 服务端已记录读取失败；保留当前内容，在下个周期重新读取。
        })
    }
    const start = () => {
      if (timer === undefined) timer = setInterval(refresh, ANNOUNCEMENT_POLL_INTERVAL_MS)
    }
    const stop = () => {
      if (timer !== undefined) clearInterval(timer)
      timer = undefined
    }
    const onVisibilityChange = () => {
      if (document.hidden) return stop()
      refresh()
      start()
    }
    if (!document.hidden) start()
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => {
      active = false
      stop()
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [initial])
  if (!announcement) return null
  return (
    <aside
      aria-label={m.admin_site_announcement()}
      role="status"
      className="border-b bg-muted px-6 py-3 text-center whitespace-pre-wrap"
    >
      {announcement}
    </aside>
  )
}
