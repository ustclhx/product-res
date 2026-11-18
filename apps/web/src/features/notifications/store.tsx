import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { getNotifications, readNotifications } from './notifications.functions.ts'

export type NotificationPage = Awaited<ReturnType<typeof getNotifications>>
export type NotificationRow = NotificationPage['rows'][number]

/** loading：还没有拿到第一页；error：还没有拿到过数据且读取失败（铃铛不显示角标） */
export type NotificationStatus = 'loading' | 'ready' | 'error'

export interface NotificationsState {
  slug: string
  status: NotificationStatus
  /** 第一页（offset 0）；还没有拿到数据时为 null */
  page: NotificationPage | null
  /** 重新读取第一页；showLoading 时先切到加载态（错误态的「重试」） */
  refresh: (options?: { showLoading?: boolean }) => Promise<void>
  /** 标为已读（不传 id 为全部），随后刷新第一页；返回服务端校验过的跳转链接 */
  markRead: (id?: string) => Promise<{ link: string | null }>
  /** 「查看全部通知」：请求首页通知区展开并滚动到可见位置（同一地址再次点击也生效） */
  revealCenter: () => void
  /** 最近一次展开请求的序号，0 为没有请求 */
  revealRequest: number
  /** 通知区处理展开请求：该请求尚未处理时返回 true 并标记为已处理 */
  acknowledgeReveal: (request: number) => boolean
}

export const POLL_INTERVAL_MS = 30_000

export const NotificationsContext = createContext<NotificationsState | null>(null)

/**
 * 工作台通知数据（评审清单 #90）：铃铛与首页通知区共用这一份第一页数据与 30 秒轮询，
 * 不各自请求。布局按空间渲染一次（key 为 slug）。标签页隐藏时暂停轮询（无人查看时不访问数据库，
 * 见 Neon 成本基线），回到前台立即刷新一次。
 */
export function NotificationsProvider({ slug, children }: { slug: string; children: ReactNode }) {
  const [status, setStatus] = useState<NotificationStatus>('loading')
  const [page, setPage] = useState<NotificationPage | null>(null)
  const [revealRequest, setRevealRequest] = useState(0)
  const acknowledgedRevealRef = useRef(0)
  // 并发的读取只采用最后发出的一次，避免较早的轮询结果覆盖标为已读后的新结果
  const requestRef = useRef(0)
  const hasDataRef = useRef(false)

  const refresh = useCallback(
    async (options?: { showLoading?: boolean }) => {
      const request = ++requestRef.current
      if (options?.showLoading) setStatus('loading')
      try {
        const next = await getNotifications({ data: { slug, offset: 0 } })
        if (request !== requestRef.current) return
        hasDataRef.current = true
        setPage(next)
        setStatus('ready')
      } catch {
        // 通知读取失败只降级入口，不阻止应用布局使用。已经有数据时单次失败保留列表与角标，
        // 只有还没拿到过数据时才进入错误态
        if (request !== requestRef.current) return
        setStatus(hasDataRef.current ? 'ready' : 'error')
      }
    },
    [slug],
  )

  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | undefined
    const start = () => {
      if (timer === undefined) timer = setInterval(() => void refresh(), POLL_INTERVAL_MS)
    }
    const stop = () => {
      if (timer !== undefined) clearInterval(timer)
      timer = undefined
    }
    const onVisibilityChange = () => {
      if (document.hidden) return stop()
      void refresh()
      start()
    }
    void refresh()
    if (!document.hidden) start()
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => {
      stop()
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [refresh])

  const markRead = useCallback(
    async (id?: string) => {
      const { link } = await readNotifications({ data: { slug, ...(id ? { id } : {}) } })
      await refresh()
      return { link }
    },
    [slug, refresh],
  )

  const revealCenter = useCallback(() => setRevealRequest((request) => request + 1), [])
  const acknowledgeReveal = useCallback((request: number) => {
    if (request === 0 || request === acknowledgedRevealRef.current) return false
    acknowledgedRevealRef.current = request
    return true
  }, [])

  const value = useMemo(
    () => ({
      slug,
      status,
      page,
      refresh,
      markRead,
      revealCenter,
      revealRequest,
      acknowledgeReveal,
    }),
    [slug, status, page, refresh, markRead, revealCenter, revealRequest, acknowledgeReveal],
  )
  return <NotificationsContext.Provider value={value}>{children}</NotificationsContext.Provider>
}

export function useNotifications(): NotificationsState {
  const value = useContext(NotificationsContext)
  if (!value) throw new Error('useNotifications must be used within NotificationsProvider')
  return value
}

/** 铃铛角标：未读为 0、加载中或出错时不显示；超过 99 显示 99+ */
export function badgeText(status: NotificationStatus, unread: number): string | null {
  if (status !== 'ready' || unread <= 0) return null
  return unread > 99 ? '99+' : String(unread)
}
