import { Button, cn } from '@product-res/ui'
import { useRouter } from '@tanstack/react-router'
import { useCallback, useEffect, useState } from 'react'
import { getNotifications, readNotifications } from './notifications.functions.ts'

type NotificationPage = Awaited<ReturnType<typeof getNotifications>>
type NotificationRow = NotificationPage['rows'][number]

const timeFormat = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Singapore',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
})

/** 顶栏通知入口：铃铛按钮 + 未读徽标，展开后显示通知列表（与顶栏账号菜单同风格的浮层） */
export function NotificationCenter({ slug }: { slug: string }) {
  const router = useRouter()
  const [head, setHead] = useState<NotificationPage>({ rows: [], unread: 0, hasMore: false })
  // “加载更多”追加的后续页；轮询只刷新第一页，不丢弃已加载的后续页
  const [tail, setTail] = useState<{ rows: NotificationRow[]; hasMore: boolean } | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const refresh = useCallback(async () => {
    try {
      setHead(await getNotifications({ data: { slug, offset: 0 } }))
      setError('')
    } catch {
      // 通知读取失败只降级入口，不阻止应用布局使用。
      setError('通知暂不可用，请刷新重试')
    }
  }, [slug])
  useEffect(() => {
    void refresh()
    const timer = setInterval(() => void refresh(), 30000)
    return () => clearInterval(timer)
  }, [refresh])

  const headIds = new Set(head.rows.map((row) => row.id))
  const rows = [...head.rows, ...(tail?.rows ?? []).filter((row) => !headIds.has(row.id))]
  const hasMore = tail ? tail.hasMore : head.hasMore

  async function loadMore() {
    setBusy(true)
    try {
      const next = await getNotifications({ data: { slug, offset: rows.length } })
      setTail({ rows: [...(tail?.rows ?? []), ...next.rows], hasMore: next.hasMore })
    } catch {
      setError('加载失败，请重试')
    } finally {
      setBusy(false)
    }
  }

  async function read(id?: string) {
    setBusy(true)
    try {
      const { link } = await readNotifications({ data: { slug, ...(id ? { id } : {}) } })
      setTail(null)
      await refresh()
      if (link) await router.navigate({ href: link })
    } catch {
      setError('标记已读失败，请重试')
    } finally {
      setBusy(false)
    }
  }

  const unread = head.unread
  return (
    <details
      className="relative"
      onToggle={(event) => {
        if (event.currentTarget.open) void refresh()
      }}
    >
      <summary
        className="relative flex size-8 cursor-pointer list-none items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground [&::-webkit-details-marker]:hidden"
        aria-label={`通知（${unread} 条未读）`}
      >
        <svg
          viewBox="0 0 24 24"
          className="size-[18px]"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
          <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
        </svg>
        {/* 0 条时徽标不显示，但保留节点（视觉隐藏）供读屏与测试读取数量 */}
        <span
          data-testid="notification-unread"
          className={
            unread > 0
              ? 'absolute -top-0.5 -right-0.5 flex min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-semibold leading-4 text-white'
              : 'sr-only'
          }
        >
          {unread > 99 ? '99+' : unread}
        </span>
      </summary>
      <section
        className="absolute right-0 z-20 mt-2 grid w-80 gap-2 rounded-lg border bg-popover p-3 text-sm shadow-md"
        aria-label="通知中心"
      >
        <div className="flex items-center justify-between">
          <h2 className="text-[13px] font-semibold">通知</h2>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={busy || unread === 0}
            onClick={() => void read()}
          >
            全部已读
          </Button>
        </div>
        {error ? (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        ) : null}
        {rows.length === 0 ? (
          <p className="py-6 text-center text-xs text-muted-foreground">暂无通知</p>
        ) : (
          <ul className="grid max-h-96 gap-1 overflow-y-auto">
            {rows.map((row) => (
              <li key={row.id}>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void read(row.id)}
                  className={cn(
                    'grid w-full gap-0.5 rounded-md px-2 py-1.5 text-left hover:bg-accent',
                    row.readAt && 'text-muted-foreground',
                  )}
                >
                  <span className="flex items-center gap-1.5 text-[13px] font-medium">
                    {row.readAt ? null : (
                      <span className="size-1.5 shrink-0 rounded-full bg-primary" aria-hidden />
                    )}
                    {row.title}
                  </span>
                  {row.body ? <span className="text-xs">{row.body}</span> : null}
                  <span className="text-[11px] text-muted-foreground">
                    {timeFormat.format(new Date(row.createdAt))}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {hasMore ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={() => void loadMore()}
          >
            加载更多
          </Button>
        ) : null}
      </section>
    </details>
  )
}
