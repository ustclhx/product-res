import { useEffect, useState } from 'react'
import { m } from '../../paraglide/messages.js'
import { getAnnouncement } from './settings-announcement.functions.ts'

export function AnnouncementBanner({ initial }: { initial: string }) {
  const [announcement, setAnnouncement] = useState(initial)
  useEffect(() => {
    setAnnouncement(initial)
    let active = true
    const timer = setInterval(() => {
      void getAnnouncement()
        .then((value) => {
          if (active) setAnnouncement(value)
        })
        .catch(() => {
          // 服务端已记录读取失败；保留当前内容，在下个周期重新读取。
        })
    }, 60_000)
    return () => {
      active = false
      clearInterval(timer)
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
