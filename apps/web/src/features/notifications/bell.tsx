import {
  Alert,
  AlertDescription,
  AlertTitle,
  Button,
  cn,
  Popover,
  PopoverContent,
  PopoverTitle,
  PopoverTrigger,
  Sheet,
  SheetClose,
  SheetContent,
  SheetTitle,
  SheetTrigger,
} from '@product-res/ui'
import { Bell, Check, ChevronRight, CircleAlert, X } from '@product-res/ui/icons'
import { Link, useRouter } from '@tanstack/react-router'
import {
  type ComponentPropsWithoutRef,
  forwardRef,
  type ReactNode,
  useEffect,
  useId,
  useState,
  useSyncExternalStore,
} from 'react'
import { m } from '../../paraglide/messages.js'
import { getLocale } from '../../paraglide/runtime.js'
import {
  badgeText,
  type NotificationRow,
  type NotificationStatus,
  useNotifications,
} from './store.tsx'
import { relativeTime } from './time.ts'

// 工作台顶部条的通知铃铛（评审清单 #90，验收依据 docs/design-system/prototypes/ui-review/Notifications*.dc.html）：
// ≥ md 为 384px 的 Popover，右缘对齐铃铛；< md 为底部 Sheet（模态、锁定焦点、触控目标 ≥ 44px）。
// 数据来自 NotificationsProvider（与首页通知区共用第一页与轮询），只显示前 5 条。

export const BELL_LIMIT = 5

// 与 Tailwind md 断点一致；服务端与水合首帧按桌面渲染
const DESKTOP_QUERY = '(min-width: 48rem)'
function subscribeDesktop(onChange: () => void) {
  const query = window.matchMedia(DESKTOP_QUERY)
  query.addEventListener('change', onChange)
  return () => query.removeEventListener('change', onChange)
}
const desktopSnapshot = () => window.matchMedia(DESKTOP_QUERY).matches
const desktopServerSnapshot = () => true

export function bellLabel(status: NotificationStatus, unread: number) {
  // 加载中或出错时不知道未读数：用中性的「通知」，不说「没有未读」
  if (status !== 'ready') return m.notifications_title()
  return unread > 0
    ? m.notifications_bell_label({ count: unread })
    : m.notifications_bell_label_none()
}

/** 铃铛按钮本身（Popover / Sheet 的 Trigger 经 asChild 合成到它上面） */
export const BellButton = forwardRef<
  HTMLButtonElement,
  { status: NotificationStatus; unread: number } & ComponentPropsWithoutRef<'button'>
>(({ status, unread, className, ...props }, ref) => {
  const badge = badgeText(status, unread)
  return (
    <Button
      ref={ref}
      variant="ghost"
      size="icon"
      aria-label={bellLabel(status, unread)}
      title={m.notifications_title()}
      data-testid="notification-bell"
      className={cn(
        'relative text-muted-foreground data-[state=open]:bg-active data-[state=open]:text-foreground print:hidden',
        className,
      )}
      {...props}
    >
      <Bell className="size-4.5 md:size-4" aria-hidden="true" />
      {badge ? (
        // 数字只给视觉；可读名称里已有未读数，避免重复朗读
        <span
          aria-hidden="true"
          data-testid="notification-badge"
          className="absolute top-px right-px inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 font-semibold text-background text-micro tabular-nums ring-2 ring-surface-2"
        >
          {badge}
        </span>
      ) : null}
    </Button>
  )
})
BellButton.displayName = 'BellButton'

export function NotificationBell() {
  const { slug, status, page, refresh, markRead, revealCenter } = useNotifications()
  const router = useRouter()
  const desktop = useSyncExternalStore(subscribeDesktop, desktopSnapshot, desktopServerSnapshot)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState('')
  const titleId = useId()
  const rowIdPrefix = useId()
  const unread = page?.unread ?? 0

  // 断点变化时收起：Popover 与 Sheet 是两套组件，不在打开期间切换
  const [layoutDesktop, setLayoutDesktop] = useState(desktop)
  if (layoutDesktop !== desktop) {
    setLayoutDesktop(desktop)
    setOpen(false)
  }

  function onOpenChange(next: boolean) {
    setOpen(next)
    setActionError('')
    if (next) void refresh()
  }

  // 操作完成、busy 变回 false 后再移焦点：行尾的勾与「全部标为已读」会消失或禁用，焦点移到对应的行
  // （全部时为第一行），不落到 body
  const [focusAfter, setFocusAfter] = useState<{ id: string | undefined } | null>(null)
  useEffect(() => {
    if (busy || !focusAfter) return
    const target = focusAfter.id
      ? document.getElementById(`${rowIdPrefix}${focusAfter.id}`)
      : document.querySelector<HTMLElement>(`[id^="${CSS.escape(rowIdPrefix)}"]`)
    target?.focus()
    setFocusAfter(null)
  }, [busy, focusAfter, rowIdPrefix])

  async function act(id: string | undefined, follow: boolean) {
    // busy 期间按钮用 aria-disabled（保持可聚焦），这里拦下重复操作
    if (busy) return
    setBusy(true)
    setActionError('')
    try {
      const { link } = await markRead(id)
      if (follow && link) {
        setOpen(false)
        await router.navigate({ href: link })
        return
      }
      setFocusAfter({ id })
    } catch {
      setActionError(m.notifications_action_failed())
    } finally {
      setBusy(false)
    }
  }

  const panel = (
    <NotificationPanel
      variant={desktop ? 'popover' : 'sheet'}
      titleId={titleId}
      rowIdPrefix={rowIdPrefix}
      status={status}
      rows={page?.rows.slice(0, BELL_LIMIT) ?? []}
      unread={unread}
      busy={busy}
      actionError={actionError}
      onOpen={(id) => void act(id, true)}
      onMark={(id) => void act(id, false)}
      onMarkAll={() => void act(undefined, false)}
      onRetry={() => void refresh({ showLoading: true })}
      viewAll={(className, children) => (
        <Link
          to="/app/$slug"
          params={{ slug }}
          hash="notifications"
          className={className}
          onClick={() => {
            setOpen(false)
            revealCenter()
          }}
        >
          {children}
        </Link>
      )}
    />
  )
  const trigger = <BellButton status={status} unread={unread} />

  return desktop ? (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent
        align="end"
        sideOffset={8}
        aria-labelledby={titleId}
        className="flex w-96 flex-col p-0"
      >
        {panel}
      </PopoverContent>
    </Popover>
  ) : (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetTrigger asChild>{trigger}</SheetTrigger>
      <SheetContent
        side="bottom"
        showCloseButton={false}
        // 没有描述段落：显式清空 aria-describedby，避免 Radix 的缺少 Description 警告
        aria-describedby={undefined}
      >
        {panel}
      </SheetContent>
    </Sheet>
  )
}

export interface NotificationPanelProps {
  variant: 'popover' | 'sheet'
  titleId: string
  rowIdPrefix: string
  status: NotificationStatus
  rows: readonly NotificationRow[]
  unread: number
  busy: boolean
  actionError: string
  onOpen: (id: string) => void
  onMark: (id: string) => void
  onMarkAll: () => void
  onRetry: () => void
  /** 「查看全部通知」链接（渲染函数，便于脱离路由测试） */
  viewAll: (className: string, children: ReactNode) => ReactNode
  /** 相对时间的基准（测试用） */
  now?: Date
}

/** 弹层 / 底部面板的内容：正常、空、加载、错误四种状态 */
export function NotificationPanel(props: NotificationPanelProps) {
  const { variant, titleId, status, rows, unread, busy, actionError, onMarkAll, viewAll } = props
  const sheet = variant === 'sheet'
  const ready = status === 'ready'
  const empty = ready && rows.length === 0
  const unreadBadge =
    ready && unread > 0 ? (
      <span className="inline-flex h-5 items-center whitespace-nowrap rounded-full bg-active px-2 font-medium text-caption">
        {m.notifications_unread_count({ count: unread })}
      </span>
    ) : null
  const markAll = (
    <Button
      variant="ghost"
      size="sm"
      disabled={!ready || unread === 0}
      aria-disabled={busy || undefined}
      onClick={onMarkAll}
      className={cn('text-foreground', sheet ? 'h-11 px-2' : 'px-2.5')}
    >
      {m.notifications_mark_all_read()}
    </Button>
  )

  return (
    <>
      {sheet ? (
        <>
          <div className="flex items-center gap-2 pt-1 pr-1 pl-4">
            <SheetTitle id={titleId}>{m.notifications_title()}</SheetTitle>
            {unreadBadge}
            <span className="flex-1" />
            <SheetClose asChild>
              <Button
                variant="ghost"
                size="icon"
                aria-label={m.notifications_close()}
                className="size-11 text-muted-foreground"
              >
                <X className="size-4.5" aria-hidden="true" />
              </Button>
            </SheetClose>
          </div>
          <div className="flex items-center justify-between gap-2 border-b pr-2 pb-1 pl-4">
            <span className="text-caption text-muted-foreground">
              {m.notifications_latest_short({ count: BELL_LIMIT })}
            </span>
            {markAll}
          </div>
        </>
      ) : (
        <div className="flex items-center gap-2 border-b py-2.5 pr-2.5 pl-4">
          <PopoverTitle id={titleId}>{m.notifications_title()}</PopoverTitle>
          {unreadBadge}
          <span className="flex-1" />
          {markAll}
        </div>
      )}
      <div className={cn('flex min-h-0 flex-col', sheet && 'flex-1 overflow-y-auto')}>
        {actionError ? (
          <p role="alert" className="px-4 pt-2 text-caption text-destructive">
            {actionError}
          </p>
        ) : null}
        {status === 'loading' ? <PanelSkeleton sheet={sheet} /> : null}
        {status === 'error' ? (
          <Alert variant="destructive" className="m-3 w-auto">
            <CircleAlert aria-hidden="true" />
            <AlertTitle>{m.notifications_error_title()}</AlertTitle>
            <AlertDescription className="gap-2.5 text-destructive">
              <span>{m.notifications_error_desc()}</span>
              <Button
                variant="outline"
                size="sm"
                className="text-foreground"
                onClick={props.onRetry}
              >
                {m.notifications_retry()}
              </Button>
            </AlertDescription>
          </Alert>
        ) : null}
        {empty ? (
          <div className="flex flex-col items-center gap-2 px-6 pt-8 pb-9 text-center">
            <div
              aria-hidden="true"
              className="flex h-16 w-24 items-center justify-center rounded-xl border border-dashed text-muted-foreground"
            >
              <Bell className="size-5.5" />
            </div>
            <span className="mt-1 font-semibold text-subtitle">
              {m.notifications_empty_title()}
            </span>
            <span className="max-w-72 text-balance text-muted-foreground">
              {m.notifications_empty_desc()}
            </span>
          </div>
        ) : null}
        {ready && rows.length > 0 ? <PanelList {...props} /> : null}
      </div>
      {ready && rows.length > 0 ? (
        sheet ? (
          <div className="border-t px-4 pt-3 pb-5">
            {viewAll(
              'inline-flex h-11 w-full items-center justify-center rounded-lg font-medium text-body ring-1 ring-border ring-inset outline-none hover:bg-hover focus-visible:outline-2 focus-visible:outline-(--focus-ring) focus-visible:outline-offset-2',
              m.notifications_view_all(),
            )}
          </div>
        ) : (
          <div className="flex h-11 items-center justify-between gap-3 border-t pr-2 pl-4">
            <span className="text-caption text-muted-foreground">
              {m.notifications_latest({ count: BELL_LIMIT })}
            </span>
            {viewAll(
              'inline-flex h-8 items-center gap-1 rounded-lg px-2 font-medium text-body outline-none hover:bg-hover focus-visible:outline-2 focus-visible:outline-(--focus-ring) focus-visible:outline-offset-2',
              <>
                {m.notifications_view_all()}
                <ChevronRight className="size-3.5" aria-hidden="true" />
              </>,
            )}
          </div>
        )
      ) : null}
    </>
  )
}

function PanelList({
  variant,
  rowIdPrefix,
  rows,
  busy,
  onOpen,
  onMark,
  now,
}: NotificationPanelProps) {
  const sheet = variant === 'sheet'
  const locale = getLocale()
  return (
    <ul aria-label={m.notifications_recent()} className="m-0 flex list-none flex-col gap-0.5 p-1">
      {rows.map((row) => {
        const unread = !row.readAt
        return (
          <li key={row.id} className="flex items-start gap-0.5">
            <button
              type="button"
              id={`${rowIdPrefix}${row.id}`}
              aria-disabled={busy || undefined}
              onClick={() => onOpen(row.id)}
              className={cn(
                'flex min-w-0 flex-1 items-start gap-2.5 rounded-lg pl-3 text-left outline-none hover:bg-hover focus-visible:outline-2 focus-visible:outline-(--focus-ring) aria-disabled:cursor-default',
                sheet ? 'py-3 pr-1' : 'py-2.5 pr-2',
              )}
            >
              <span
                aria-hidden="true"
                className={cn(
                  'mt-1.5 size-2 shrink-0 rounded-full',
                  unread ? 'bg-primary' : 'bg-transparent',
                )}
              />
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="flex items-center gap-2">
                  {unread ? (
                    <span className="sr-only">{m.notifications_unread_prefix()}</span>
                  ) : null}
                  <span
                    className={cn(
                      'min-w-0 flex-1 truncate',
                      unread ? 'font-semibold text-foreground' : 'text-muted-foreground',
                    )}
                  >
                    {row.title}
                  </span>
                  <span className="whitespace-nowrap text-caption text-muted-foreground">
                    {relativeTime(row.createdAt, locale, now)}
                  </span>
                </span>
                {row.body ? (
                  <span className="line-clamp-2 text-caption text-muted-foreground">
                    {row.body}
                  </span>
                ) : null}
              </span>
            </button>
            {unread ? (
              <Button
                variant="ghost"
                size={sheet ? 'icon' : 'icon-sm'}
                aria-label={m.notifications_mark_read({ title: row.title })}
                title={m.notifications_mark_read_hint()}
                aria-disabled={busy || undefined}
                onClick={() => onMark(row.id)}
                className={cn('text-muted-foreground', sheet ? 'mt-0.5 size-11' : 'mt-1.5')}
              >
                <Check className="size-4" aria-hidden="true" />
              </Button>
            ) : (
              <span aria-hidden="true" className={cn('shrink-0', sheet ? 'size-11' : 'size-7')} />
            )}
          </li>
        )
      })}
    </ul>
  )
}

const SKELETON_WIDTHS = [
  ['w-1/2', 'w-4/5'],
  ['w-2/5', 'w-2/3'],
  ['w-3/5', 'w-5/6'],
  ['w-1/3', 'w-3/5'],
] as const

function PanelSkeleton({ sheet }: { sheet: boolean }) {
  return (
    <div role="status" aria-label={m.notifications_loading()} className="flex flex-col gap-0.5 p-1">
      {SKELETON_WIDTHS.slice(0, sheet ? 3 : 4).map(([first, second]) => (
        <div key={first} className={cn('flex gap-2.5 pl-3', sheet ? 'py-3 pr-1' : 'py-2.5 pr-2')}>
          <span className="mt-1.5 size-2 shrink-0 animate-pulse rounded-full bg-active motion-reduce:animate-none" />
          <span className="flex flex-1 flex-col gap-2 py-1">
            <span
              className={cn(
                'h-3 animate-pulse rounded-md bg-active motion-reduce:animate-none',
                first,
              )}
            />
            <span
              className={cn(
                'h-2.5 animate-pulse rounded-md bg-active motion-reduce:animate-none',
                second,
              )}
            />
          </span>
        </div>
      ))}
    </div>
  )
}
