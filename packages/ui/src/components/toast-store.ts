// Toast 的命令式 store（模板新增，tasks 4.2 审阅）：零依赖（不引用 React 组件、Radix 与 motion），
// 业务代码在任何地方调用 `toast()` 都不会把 Toaster 与动效库带进当前页面的包；Toaster 在 toast.tsx 中订阅它。
// 应用在 app / admin 布局用 React.lazy 挂载 Toaster，不放进根布局（docs/design-system.md §4）。
import type { MouseEvent, ReactNode } from 'react'

type ToastVariant = 'default' | 'success' | 'error'

interface ToastAction {
  /** 按钮文字 */
  label: string
  /** 点击回调；调用 `event.preventDefault()` 可阻止随后的关闭 */
  onClick: (event: MouseEvent<HTMLButtonElement>) => void
  /** 屏幕阅读器播报时替代按钮的说明（Radix 要求）；省略时用 label */
  altText?: string
}

interface ToastOptions {
  /** 传入已有 id 时更新该条（与 sonner 一致），否则新建 */
  id?: string
  description?: ReactNode
  variant?: ToastVariant
  /** 毫秒；省略时用 Toaster 的 duration，`Infinity` 表示不自动消失 */
  duration?: number
  action?: ToastAction
  /** 无论以何种方式关闭（计时、关闭按钮、Esc、滑动、action、toast.dismiss）都会调用一次 */
  onDismiss?: (id: string) => void
}

export interface ToastRecord extends Omit<ToastOptions, 'id'> {
  id: string
  title: ReactNode
  open: boolean
}

// ---------------------------------------------------------------------------
// Store：模块级单例。dismiss 先把 open 置 false 播放退场，退场时长后再移除。
// ---------------------------------------------------------------------------

// 退场动画时长（与 Toaster 的 spring.moderate.exit 一致，springs.ts 的 exitFallbackMs）；store 不依赖动效库
export const TOAST_EXIT_MS = 220
const EXIT_MS = TOAST_EXIT_MS
const EMPTY: ToastRecord[] = []

let records: ToastRecord[] = EMPTY
let counter = 0
const listeners = new Set<() => void>()
const removalTimers = new Map<string, ReturnType<typeof setTimeout>>()

function emit() {
  for (const listener of listeners) listener()
}

export function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export const getSnapshot = () => records
// 服务端与水合首帧都不输出 toast
export const getServerSnapshot = () => EMPTY

function show(title: ReactNode, options: ToastOptions = {}): string {
  const { id: givenId, ...rest } = options
  const id = givenId ?? `toast-${++counter}`
  const timer = removalTimers.get(id)
  if (timer !== undefined) {
    clearTimeout(timer)
    removalTimers.delete(id)
  }
  const next: ToastRecord = { ...rest, id, title, open: true }
  const exists = records.some((r) => r.id === id)
  records = exists ? records.map((r) => (r.id === id ? next : r)) : [...records, next]
  emit()
  return id
}

export function dismiss(id?: string) {
  const closing = records.filter((r) => r.open && (id === undefined || r.id === id))
  if (closing.length === 0) return
  const ids = new Set(closing.map((r) => r.id))
  records = records.map((r) => (ids.has(r.id) ? { ...r, open: false } : r))
  emit()
  for (const record of closing) {
    removalTimers.set(
      record.id,
      setTimeout(() => {
        removalTimers.delete(record.id)
        records = records.filter((r) => r.id !== record.id)
        emit()
      }, EXIT_MS),
    )
    record.onDismiss?.(record.id)
  }
}

type ToastFn = ((title: ReactNode, options?: ToastOptions) => string) & {
  success: (title: ReactNode, options?: Omit<ToastOptions, 'variant'>) => string
  error: (title: ReactNode, options?: Omit<ToastOptions, 'variant'>) => string
  /** 关闭指定 id；省略 id 时关闭全部 */
  dismiss: (id?: string) => void
}

/** 命令式弹出通知，返回 id。需要页面上挂着一个 `<Toaster />`。 */
const toast: ToastFn = Object.assign(
  (title: ReactNode, options?: ToastOptions) => show(title, options),
  {
    success: (title: ReactNode, options?: Omit<ToastOptions, 'variant'>) =>
      show(title, { ...options, variant: 'success' }),
    error: (title: ReactNode, options?: Omit<ToastOptions, 'variant'>) =>
      show(title, { ...options, variant: 'error' }),
    dismiss,
  },
)

/** 仅供测试：立即清空 store 与计时器（模块级单例在测试之间共享） */
function resetToastsForTesting() {
  for (const timer of removalTimers.values()) clearTimeout(timer)
  removalTimers.clear()
  records = EMPTY
  counter = 0
  emit()
}

export type { ToastAction, ToastFn, ToastOptions, ToastVariant }
export { resetToastsForTesting, toast }
