import { cn } from '@product-res/ui'
import { type ReactNode, useEffect, useId } from 'react'

/**
 * 轻量模态对话框：packages/ui 暂无 Dialog，这里用遮罩 + role="dialog" 实现，Esc 与遮罩点击关闭。
 * 只在 open 时挂载内容，关闭即卸载（升级对话框据此在每次打开时生成新的幂等键）。
 */
export function Modal({
  open,
  title,
  onClose,
  children,
  footer,
  className,
}: {
  open: boolean
  title: ReactNode
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
  className?: string
}) {
  const titleId = useId()
  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])
  if (!open) return null
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center">
      <button
        type="button"
        aria-hidden="true"
        tabIndex={-1}
        className="absolute inset-0 cursor-default bg-black/40"
        onClick={onClose}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className={cn(
          'relative z-10 grid max-h-[90vh] w-full max-w-lg grid-rows-[auto_1fr_auto] overflow-hidden rounded-t-xl border bg-card shadow-lg sm:rounded-xl',
          className,
        )}
      >
        <h2 id={titleId} className="border-b px-4 py-3 text-sm font-semibold">
          {title}
        </h2>
        <div className="grid min-h-0 gap-3 overflow-y-auto px-4 py-3 text-[13px]">{children}</div>
        {footer ? (
          <div className="flex flex-wrap justify-end gap-2 border-t px-4 py-3">{footer}</div>
        ) : null}
      </div>
    </div>
  )
}
