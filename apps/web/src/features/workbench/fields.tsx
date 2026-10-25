import { cn } from '@product-res/ui'
import { type ReactNode, useId, useState } from 'react'
import { workbenchErrorText } from './errors.ts'

/** 工作台配置表单的小部件：与 Input 同一套边框、圆角和 13px 正文 */
export const controlClass =
  'h-8 w-full rounded-md border border-input bg-background px-2.5 text-[13px] outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50'

export function Field({
  label,
  hint,
  children,
  className,
}: {
  label: string
  hint?: string
  children: (id: string) => ReactNode
  className?: string
}) {
  const id = useId()
  return (
    <div className={cn('grid gap-1', className)}>
      <label htmlFor={id} className="text-xs font-medium text-muted-foreground">
        {label}
      </label>
      {children(id)}
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  )
}

/** 多选：一组复选框，legend 作为分组名 */
export function CheckboxGroup<T extends string>({
  label,
  options,
  value,
  onChange,
  empty,
}: {
  label: string
  options: readonly { value: T; label: string }[]
  value: readonly T[]
  onChange: (next: T[]) => void
  empty?: string
}) {
  return (
    <fieldset className="grid gap-1">
      <legend className="mb-1 text-xs font-medium text-muted-foreground">{label}</legend>
      {options.length === 0 ? (
        <p className="text-xs text-muted-foreground">{empty ?? '暂无可选项'}</p>
      ) : (
        <div className="flex flex-wrap gap-x-4 gap-y-1.5">
          {options.map((o) => (
            <label key={o.value} className="inline-flex items-center gap-1.5 text-[13px]">
              <input
                type="checkbox"
                className="size-3.5 accent-primary"
                checked={value.includes(o.value)}
                onChange={(e) =>
                  onChange(
                    e.target.checked ? [...value, o.value] : value.filter((v) => v !== o.value),
                  )
                }
              />
              {o.label}
            </label>
          ))}
        </div>
      )}
    </fieldset>
  )
}

/** 写操作的公共状态：进行中、错误提示，成功后回调刷新 */
export function useAction(onDone: () => Promise<void>) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  async function run(action: () => Promise<unknown>): Promise<boolean> {
    setBusy(true)
    setError('')
    try {
      await action()
      await onDone()
      return true
    } catch (e) {
      setError(workbenchErrorText(e))
      return false
    } finally {
      setBusy(false)
    }
  }
  return { busy, error, setError, run }
}

export function ErrorText({ children }: { children: string }) {
  return children ? (
    <p role="alert" className="text-xs text-destructive">
      {children}
    </p>
  ) : null
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="grid justify-items-center gap-1 rounded-lg border border-dashed px-4 py-8 text-center">
      <p className="text-[13px] font-medium">{title}</p>
      {children ? <div className="text-xs text-muted-foreground">{children}</div> : null}
    </div>
  )
}

/** 只读成员看到的说明 */
export function ReadOnlyNotice({ show }: { show: boolean }) {
  return show ? (
    <p className="rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">
      你可以查看这些配置；修改需要空间所有者或管理员，且空间不是只读。
    </p>
  ) : null
}
