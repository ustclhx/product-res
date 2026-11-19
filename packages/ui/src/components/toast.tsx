// 来源：无（Fluid 没有 Toast，按 shadcn sonner 结构补缺）：结构与 API 取 shadcn 推荐的 sonner 形态
// （`<Toaster />` 挂一次 + 命令式 `toast(...)`），底层用 radix-ui 的 Toast 原语，外观与动效沿用本包弹层；改动见 packages/ui/UPSTREAM.md
//
// 不新增依赖：Radix Toast 负责视口区域、F8 热键聚焦、滑动关闭、悬停 / 聚焦 / 窗口失焦时暂停计时与 aria-live 播报；
// 命令式 API 是模块内的极小 store，经 useSyncExternalStore 订阅。组件内没有任何默认文案：
// 区域名称、播报前缀与关闭按钮名称由 Toaster 的 labels 传入，toast 内容由调用方传入。
import { m as motion, useReducedMotion } from 'motion/react'
import { Toast as ToastPrimitive } from 'radix-ui'
import { useEffect, useLayoutEffect, useSyncExternalStore } from 'react'
import { fontWeights } from '../lib/font-weight.ts'
import { useIcons } from '../lib/icon-context.tsx'
import { MotionFeatures } from '../lib/motion-features.tsx'
import { usePopupShape } from '../lib/shape-context.tsx'
import { typeClass, useSizeVariant } from '../lib/size-context.tsx'
import { spring } from '../lib/springs.ts'
import { surfaceClasses } from '../lib/surface-classes.ts'
import { SurfaceProvider, useSurface } from '../lib/surface-context.tsx'
import { cn } from '../lib/utils.ts'
import { Button } from './button.tsx'
import {
  dismiss,
  getServerSnapshot,
  getSnapshot,
  resetToastsForTesting,
  subscribe,
  type ToastAction,
  type ToastOptions,
  type ToastRecord,
  type ToastVariant,
  toast,
} from './toast-store.ts'

// 与 select / dropdown 弹层相同：背景在所处表面上抬两级，阴影固定第 3 档
const TOAST_OFFSET = 2
const TOAST_SHADOW = 3

// 与 select / dropdown 弹层相同 —— store 见 toast-store.ts
// ---------------------------------------------------------------------------
// Toaster
// ---------------------------------------------------------------------------

type ToasterPosition = 'top-center' | 'top-right' | 'bottom-center' | 'bottom-right'

interface ToasterLabels {
  /** 视口区域的可读名称（Radix Viewport `label`），可含 `{hotkey}` 占位，如「通知（{hotkey}）」 */
  region: string
  /** 播报时加在内容前的前缀（Radix Provider `label`），如「通知」 */
  announcement: string
  /** 每条通知关闭按钮的可读名称 */
  close: string
}

interface ToasterProps {
  /** 模板改动：可读文字必须由应用按语言传入（Radix 默认英文 "Notifications ({hotkey})" / "Notification"） */
  labels: ToasterLabels
  /** @default "bottom-right" */
  position?: ToasterPosition
  /** 默认停留时长（毫秒）。@default 5000 */
  duration?: number
  /** 同时显示的最大条数；超出时最早的一条自动关闭（sonner 观感）。@default 3 */
  visibleToasts?: number
  /** 聚焦视口的热键。@default ["F8"] */
  hotkey?: string[]
  className?: string
}

const POSITION_CLASS: Record<ToasterPosition, string> = {
  'top-center': 'top-4 left-1/2 -translate-x-1/2 flex-col-reverse',
  'top-right': 'top-4 right-4 flex-col-reverse',
  'bottom-center': 'bottom-4 left-1/2 -translate-x-1/2 flex-col',
  'bottom-right': 'bottom-4 right-4 flex-col',
}

const SWIPE_DIRECTION = {
  'top-center': 'up',
  'top-right': 'right',
  'bottom-center': 'down',
  'bottom-right': 'right',
} as const

// 滑动跟手：Radix 把位移写进 CSS 变量；Tailwind v4 的 translate-* 用独立的 translate 属性，
// 与 motion 写在 style 上的 transform 叠加而不互相覆盖
const SWIPE_CLASS = {
  right:
    'data-[swipe=move]:translate-x-(--radix-toast-swipe-move-x) data-[swipe=end]:translate-x-(--radix-toast-swipe-end-x)',
  up: 'data-[swipe=move]:translate-y-(--radix-toast-swipe-move-y) data-[swipe=end]:translate-y-(--radix-toast-swipe-end-y)',
  down: 'data-[swipe=move]:translate-y-(--radix-toast-swipe-move-y) data-[swipe=end]:translate-y-(--radix-toast-swipe-end-y)',
} as const

const useIsoLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect

function Toaster({
  labels,
  position = 'bottom-right',
  duration = 5000,
  visibleToasts = 3,
  hotkey,
  className,
}: ToasterProps) {
  const all = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
  // 超出上限时直接关闭最早的几条（播放退场后移除），不排队，旧通知不会在之后「复活」
  useIsoLayoutEffect(() => {
    const open = all.filter((record) => record.open)
    for (const record of open.slice(0, Math.max(0, open.length - visibleToasts))) dismiss(record.id)
  }, [all, visibleToasts])
  const visible = all
  const swipeDirection = SWIPE_DIRECTION[position]

  return (
    <MotionFeatures>
      <ToastPrimitive.Provider
        label={labels.announcement}
        duration={duration}
        swipeDirection={swipeDirection}
      >
        {visible.map((record) => (
          <ToastItem
            key={record.id}
            record={record}
            closeLabel={labels.close}
            fromTop={position.startsWith('top')}
            swipeClass={SWIPE_CLASS[swipeDirection]}
          />
        ))}
        <ToastPrimitive.Viewport
          label={labels.region}
          {...(hotkey !== undefined && { hotkey })}
          className={cn(
            'fixed z-(--z-toast) m-0 flex list-none gap-2 p-0 outline-none',
            // 360px 窄屏两侧各留 1rem
            'w-[min(24rem,calc(100vw-2rem))]',
            POSITION_CLASS[position],
            className,
          )}
        />
      </ToastPrimitive.Provider>
    </MotionFeatures>
  )
}

function ToastItem({
  record,
  closeLabel,
  fromTop,
  swipeClass,
}: {
  record: ToastRecord
  closeLabel: string
  fromTop: boolean
  swipeClass: string
}) {
  const { id, title, description, variant = 'default', duration, action, open } = record
  const icons = useIcons()
  const XIcon = icons.x
  const CheckIcon = icons.check
  const AlertIcon = icons['circle-alert']
  const shape = usePopupShape()
  const compact = useSizeVariant() === 'compact'
  const level = Math.min(useSurface() + TOAST_OFFSET, 8)
  // 减少动态效果：只淡入淡出，不位移不缩放（不依赖 UiRoot 的 MotionConfig，单独挂载也生效）
  const reduced = useReducedMotion() === true
  const enterY = reduced ? 0 : fromTop ? -8 : 8
  const hidden = { opacity: 0, y: enterY, scale: reduced ? 1 : 0.97 }

  return (
    <ToastPrimitive.Root
      asChild
      forceMount
      open={open}
      onOpenChange={(next) => {
        if (!next) dismiss(id)
      }}
      {...(duration !== undefined && { duration })}
    >
      <motion.li
        // 退场期间不可交互，避免再次点击 action
        inert={!open}
        data-variant={variant}
        className={cn(
          'pointer-events-auto relative flex w-full items-start gap-3 p-4 pr-11 text-popover-foreground',
          surfaceClasses(level, TOAST_SHADOW),
          shape.container,
          'outline-none focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--focus-ring)',
          'data-[swipe=cancel]:translate-x-0 data-[swipe=cancel]:translate-y-0 data-[swipe=cancel]:transition-[translate] data-[swipe=cancel]:duration-150',
          swipeClass,
          !open && 'pointer-events-none',
        )}
        initial={hidden}
        animate={open ? { opacity: 1, y: 0, scale: 1 } : hidden}
        transition={open ? spring.moderate : spring.moderate.exit}
      >
        <SurfaceProvider value={level}>
          {variant === 'success' && (
            // 状态色只作图标；--success 对弹层表面 ≥ 3:1（非文字标识）
            <CheckIcon
              size={16}
              strokeWidth={2}
              className="mt-0.5 shrink-0 text-success"
              aria-hidden="true"
            />
          )}
          {variant === 'error' && (
            // 与标题同为 --destructive（文字 ≥ 4.5:1），图标只作辅助标识
            <AlertIcon
              size={16}
              strokeWidth={2}
              className="mt-0.5 shrink-0 text-destructive"
              aria-hidden="true"
            />
          )}
          <div className="grid min-w-0 flex-1 gap-1 break-words">
            <ToastPrimitive.Title
              className={cn(
                typeClass('subtitle', compact ? 'compact' : 'default'),
                // 中文回退字体需要 font-semibold 才会加粗；error 用 --destructive 文字色（≥ 4.5:1）
                'font-semibold',
                variant === 'error' ? 'text-destructive' : 'text-foreground',
              )}
              style={{ fontVariationSettings: fontWeights.semibold }}
            >
              {title}
            </ToastPrimitive.Title>
            {description !== undefined && (
              <ToastPrimitive.Description
                className={cn(
                  typeClass('body', compact ? 'compact' : 'default'),
                  'text-muted-foreground',
                )}
              >
                {description}
              </ToastPrimitive.Description>
            )}
          </div>
          {action && (
            <ToastPrimitive.Action asChild altText={action.altText ?? action.label}>
              <Button variant="outline" size="sm" className="shrink-0" onClick={action.onClick}>
                {action.label}
              </Button>
            </ToastPrimitive.Action>
          )}
          <ToastPrimitive.Close asChild>
            <Button variant="ghost" size="icon-sm" className="absolute right-2 top-2">
              <XIcon />
              <span className="sr-only">{closeLabel}</span>
            </Button>
          </ToastPrimitive.Close>
        </SurfaceProvider>
      </motion.li>
    </ToastPrimitive.Root>
  )
}

export type {
  ToastAction,
  ToasterLabels,
  ToasterPosition,
  ToasterProps,
  ToastOptions,
  ToastVariant,
}
export { resetToastsForTesting, Toaster, toast }
