import { createFormHook, createFormHookContexts, useStore } from '@tanstack/react-form'
import {
  type ComponentProps,
  createContext,
  type FormEvent,
  type ReactNode,
  useContext,
  useId,
  useRef,
} from 'react'
import { cn } from '../lib/utils.ts'
import { Button, type ButtonProps } from './button.tsx'
import { Input } from './input.tsx'
import { Label } from './label.tsx'

/**
 * TanStack Form 的表单封装（createFormHook）：页面用 `useAppForm` 建表单，
 * 校验直接传 Zod schema（Standard Schema），例如 `validators: { onBlur: schema, onSubmit: schema }`。
 *
 * 错误显示规则（TextField）：字段自己失焦过或表单提交过后才显示错误；已显示的错误在输入时
 * 即重新校验，修正后立刻消失；按下提交按钮引起的失焦不做失焦校验，交给提交统一校验。
 * 这样错误不会在 mousedown 与 mouseup 之间出现或消失，提交按钮不会因此移位而丢失点击。
 *
 * ```tsx
 * const form = useAppForm({ defaultValues, validators: { onSubmit: schema }, onSubmit })
 * <form.AppForm>
 *   <form.Form>
 *     <form.AppField name="email">{(field) => <field.TextField label="Email" type="email" />}</form.AppField>
 *     <form.SubmitButton>Sign in</form.SubmitButton>
 *   </form.Form>
 * </form.AppForm>
 * ```
 */
export const { fieldContext, formContext, useFieldContext, useFormContext } =
  createFormHookContexts()

/** 校验错误转为可显示的文案：Standard Schema 的 issue 取 message，字符串原样保留，去重 */
export function errorMessages(errors: readonly unknown[]): string[] {
  const messages = errors.flatMap((error) => {
    if (typeof error === 'string') return [error]
    if (typeof error === 'object' && error !== null && 'message' in error) {
      const { message } = error as { message: unknown }
      return typeof message === 'string' ? [message] : []
    }
    return []
  })
  return [...new Set(messages)]
}

export function FieldErrors({ id, errors }: { id: string; errors: readonly string[] }) {
  if (errors.length === 0) return null
  return (
    <div id={id} data-slot="field-error" className="text-destructive text-sm">
      {errors.map((message) => (
        <p key={message}>{message}</p>
      ))}
    </div>
  )
}

/**
 * 记录指针是否刚在提交按钮上按下。按下提交按钮会先让当前输入框失焦，若此时做失焦校验，
 * 错误的出现/消失会让按钮在 mouseup 前移位、点击落空；提交本身会校验全部字段，故跳过这次失焦校验。
 */
const SubmitPressContext = createContext<{ current: boolean } | null>(null)

export interface TextFieldProps
  extends Omit<ComponentProps<'input'>, 'id' | 'name' | 'value' | 'onChange' | 'onBlur'> {
  label: ReactNode
  /** 字段说明，显示在输入框下方 */
  description?: ReactNode
}

/** 文本类输入字段：标签 + 输入框 + 说明 + 错误（字段失焦过或表单提交过后才显示错误） */
export function TextField({ label, description, className, ...inputProps }: TextFieldProps) {
  const field = useFieldContext<string>()
  const submitPress = useContext(SubmitPressContext)
  const submitted = useStore(field.form.store, (state) => state.submissionAttempts > 0)
  const id = useId()
  // 表单级失焦校验会同时写入其他字段的错误；只看 isTouched 会让正在输入、尚未失焦的字段提前报错
  const errors =
    field.state.meta.isBlurred || submitted ? errorMessages(field.state.meta.errors) : []
  const errorId = `${id}-error`
  const descriptionId = `${id}-description`
  const describedBy =
    [description ? descriptionId : null, errors.length > 0 ? errorId : null]
      .filter(Boolean)
      .join(' ') || undefined
  return (
    <div data-slot="field" className={cn('grid gap-2', className)}>
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        name={field.name}
        value={field.state.value ?? ''}
        onChange={(event) => {
          field.handleChange(event.target.value)
          // 已显示错误时随输入重新校验，修正后错误立即消失，而不是等到失焦（点击提交）时才消失
          if (errors.length > 0) field.validate('blur')
        }}
        onBlur={() => {
          if (submitPress?.current) {
            submitPress.current = false
            return
          }
          field.handleBlur()
        }}
        aria-invalid={errors.length > 0 || undefined}
        aria-describedby={describedBy}
        {...inputProps}
      />
      {description ? (
        <p id={descriptionId} className="text-muted-foreground text-sm">
          {description}
        </p>
      ) : null}
      <FieldErrors id={errorId} errors={errors} />
    </div>
  )
}

/** `<form>`：阻止浏览器默认提交与原生校验，交给 TanStack Form 处理 */
export function Form({
  className,
  onPointerDownCapture,
  onClickCapture,
  ...props
}: Omit<ComponentProps<'form'>, 'onSubmit'>) {
  const form = useFormContext()
  const submitPress = useRef(false)
  return (
    <SubmitPressContext.Provider value={submitPress}>
      <form
        noValidate
        className={cn('grid gap-4', className)}
        onSubmit={(event: FormEvent<HTMLFormElement>) => {
          event.preventDefault()
          event.stopPropagation()
          // 当前聚焦字段可能带着其他字段失焦时写入的过期错误（其失焦校验被跳过，或用回车提交）；
          // TanStack Form 首次提交在 canSubmit 为 false 时直接返回、不重新校验，会吞掉这次提交，
          // 故先按当前值刷新表单级失焦校验再提交
          void Promise.resolve(form.validate('blur')).then(() => form.handleSubmit())
        }}
        // pointerdown 先于输入框 blur 触发：记录是否按在提交按钮上；click 后清除
        onPointerDownCapture={(event) => {
          submitPress.current =
            event.target instanceof Element &&
            event.target.closest('button[type="submit"]') !== null
          onPointerDownCapture?.(event)
        }}
        onClickCapture={(event) => {
          submitPress.current = false
          onClickCapture?.(event)
        }}
        {...props}
      />
    </SubmitPressContext.Provider>
  )
}

export interface SubmitButtonProps extends Omit<ButtonProps, 'type' | 'asChild'> {
  /** 提交中显示的文案，省略时沿用 children */
  pendingLabel?: ReactNode
}

/** 提交按钮：提交中禁用并显示 `pendingLabel` */
export function SubmitButton({ children, pendingLabel, disabled, ...props }: SubmitButtonProps) {
  const form = useFormContext()
  return (
    <form.Subscribe selector={(state) => state.isSubmitting}>
      {(isSubmitting) => (
        <Button
          type="submit"
          disabled={isSubmitting || disabled}
          aria-busy={isSubmitting || undefined}
          {...props}
        >
          {isSubmitting && pendingLabel !== undefined ? pendingLabel : children}
        </Button>
      )}
    </form.Subscribe>
  )
}

export const { useAppForm, withForm } = createFormHook({
  fieldContext,
  formContext,
  fieldComponents: { TextField },
  formComponents: { Form, SubmitButton },
})
