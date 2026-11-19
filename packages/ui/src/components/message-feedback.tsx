// 模板新增（openspec add-ui-design-system tasks 8.6，设计稿 docs/design-system/prototypes/ui-review/Chat.dc.html）：
// 消息评分与文字反馈。纯展示：评分经 onChange 交给调用方保存（null = 撤销），失败时 reject，组件回滚并提示。
// 交互：点赞 / 点踩再次点击即撤销；点踩展开文字反馈，提交后可经「修改反馈」再次编辑。
// 可选的「共享对话」勾选项（openspec add-subject-chat tasks 10）：传入 `shareLabels` 才显示，默认不勾选，
// 随表单提交；切到点赞或撤销时清除，再次提交时不勾选即撤回。
import { ThumbsDown, ThumbsUp } from 'lucide-react'
import { type ReactNode, useEffect, useId, useRef, useState } from 'react'
import { cn } from '../lib/utils.ts'
import { Button } from './button.tsx'
import { Checkbox } from './checkbox.tsx'
import { Label } from './label.tsx'
import { Textarea } from './textarea.tsx'

type FeedbackRating = 'up' | 'down'

interface MessageFeedbackValue {
  rating: FeedbackRating
  /** 文字反馈；没有时为 null */
  comment: string | null
  /** 选中的原因（`reasons` 中的 value）；未传 `reasons` 时不出现 */
  reason?: string | null
  /** 是否同意共享这段对话；未传 `shareLabels` 时不出现 */
  shareConversation?: boolean
}

interface MessageFeedbackShareLabels {
  /** 勾选项文字，如「把这段对话共享给我们用于改进」 */
  label: string
  /** 说明会共享哪些内容，如「包括这条回复和它之前最近 3 条消息」 */
  description: string
}

interface MessageFeedbackReason {
  value: string
  label: string
}

interface MessageFeedbackLabels {
  /** 按钮组的可读名称，如「评价这条回答」 */
  group: string
  up: string
  down: string
  /** 反馈表单标题，如「这条回答哪里不满意？」 */
  question: string
  /** 文字框标签，如「补充说明（可选）」 */
  comment: string
  commentPlaceholder?: string
  submit: string
  cancel: string
  /** 已点踩且表单收起时，重新打开表单的按钮文字 */
  edit: string
  /** 提交文字反馈成功后的提示 */
  saved: string
  /** 保存失败（已回滚）的提示 */
  failed: string
}

interface MessageFeedbackProps {
  /** null = 未评分 */
  value: MessageFeedbackValue | null
  /** null = 撤销；保存失败时 reject，组件回滚到之前的值并显示 labels.failed */
  onChange: (next: MessageFeedbackValue | null) => Promise<void> | void
  labels: MessageFeedbackLabels
  /** 点踩原因（单选，可再次点击取消）；不传时只有文字框 */
  reasons?: readonly MessageFeedbackReason[]
  /** 反馈表单中的「共享对话」勾选项文案；不传时不显示勾选项，回调值也不含 `shareConversation` */
  shareLabels?: MessageFeedbackShareLabels
  /** 只读空间或生成中 */
  disabled?: boolean
  /** 评分按钮之前的操作（如复制按钮） */
  actions?: ReactNode
  /** 评分按钮之后的说明文字（如「消耗 3 积分 · 通用模型」） */
  meta?: ReactNode
  commentMaxLength?: number
  className?: string
}

const iconButton = 'size-7 [&_svg]:size-3.5'

function MessageFeedback({
  value,
  onChange,
  labels,
  reasons,
  shareLabels,
  disabled = false,
  actions,
  meta,
  commentMaxLength = 1000,
  className,
}: MessageFeedbackProps) {
  const [current, setCurrent] = useState(value)
  const [formOpen, setFormOpen] = useState(false)
  const [comment, setComment] = useState(value?.comment ?? '')
  const [reason, setReason] = useState<string | null>(value?.reason ?? null)
  const [share, setShare] = useState(value?.shareConversation ?? false)
  const [pending, setPending] = useState(false)
  const [notice, setNotice] = useState<'saved' | 'failed' | null>(null)
  const formId = useId()
  const textareaId = useId()
  const shareId = useId()
  const shareDescriptionId = useId()
  const questionId = useId()
  const downRef = useRef<HTMLButtonElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const focusTextarea = useRef(false)

  // 调用方保存成功后会传回新值（或外部重新加载），以它为准；按字段比较，调用方每次渲染新建对象不会覆盖进行中的修改
  const valueRating = value?.rating ?? null
  const valueComment = value?.comment ?? null
  const valueReason = value?.reason ?? null
  const valueShare = value?.shareConversation ?? null
  useEffect(() => {
    setCurrent(
      valueRating
        ? {
            rating: valueRating,
            comment: valueComment,
            ...(valueReason !== null ? { reason: valueReason } : {}),
            ...(valueShare !== null ? { shareConversation: valueShare } : {}),
          }
        : null,
    )
  }, [valueRating, valueComment, valueReason, valueShare])

  useEffect(() => {
    if (formOpen && focusTextarea.current) {
      focusTextarea.current = false
      textareaRef.current?.focus()
    }
  }, [formOpen])

  async function save(
    next: MessageFeedbackValue | null,
    { onSuccess, onFailure }: { onSuccess?: () => void; onFailure?: () => void } = {},
  ) {
    const previous = current
    setCurrent(next)
    setPending(true)
    setNotice(null)
    try {
      await onChange(next)
      onSuccess?.()
    } catch {
      setCurrent(previous)
      setNotice('failed')
      onFailure?.()
    } finally {
      setPending(false)
    }
  }

  function rate(rating: FeedbackRating) {
    // 保存中忽略点击；不用 disabled，避免按钮失焦把焦点丢到 body
    if (pending) return
    // 再次点击同一评分即撤销
    const wasOpen = formOpen
    // 失败时表单开合回到点击前（评分已回滚）
    const restore = () => setFormOpen(wasOpen)
    if (current?.rating === rating) {
      setFormOpen(false)
      setComment('')
      setReason(null)
      setShare(false)
      void save(null, { onFailure: restore })
      return
    }
    setFormOpen(rating === 'down')
    if (rating === 'up') {
      // 点踩时写的文字、原因与共享同意只属于点踩，切到点赞时清空
      setComment('')
      setReason(null)
      setShare(false)
    }
    void save(
      rating === 'up'
        ? {
            rating,
            comment: null,
            ...(reasons ? { reason: null } : {}),
            ...(shareLabels ? { shareConversation: false } : {}),
          }
        : {
            rating,
            comment: current?.comment ?? null,
            ...(reasons ? { reason: current?.reason ?? null } : {}),
            ...(shareLabels ? { shareConversation: current?.shareConversation ?? false } : {}),
          },
      { onFailure: restore },
    )
  }

  function closeForm() {
    setFormOpen(false)
    setComment(current?.comment ?? '')
    setReason(current?.reason ?? null)
    setShare(current?.shareConversation ?? false)
    downRef.current?.focus()
  }

  const busy = disabled || pending
  // 评分按钮只在 disabled 时不可用，保存中仍可聚焦（见 rate）
  const rating = current?.rating ?? null
  const showForm = formOpen && rating === 'down'

  return (
    <div className={cn('flex min-w-0 flex-col gap-1', className)}>
      {/* biome-ignore lint/a11y/useSemanticElements: 按钮组不是表单字段，fieldset 会带入表单语义与默认最小宽度 */}
      <div
        role="group"
        aria-label={labels.group}
        className="-ml-1.5 flex flex-wrap items-center gap-0.5"
      >
        {actions}
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className={cn(iconButton, rating === 'up' && 'text-foreground before:bg-active')}
          aria-label={labels.up}
          aria-pressed={rating === 'up'}
          aria-busy={pending || undefined}
          disabled={disabled}
          onClick={() => rate('up')}
        >
          <ThumbsUp
            aria-hidden
            strokeWidth={1.5}
            className={cn(rating === 'up' && 'fill-current')}
          />
        </Button>
        <Button
          ref={downRef}
          type="button"
          variant="ghost"
          size="icon-sm"
          className={cn(iconButton, rating === 'down' && 'text-foreground before:bg-active')}
          aria-label={labels.down}
          aria-pressed={rating === 'down'}
          aria-expanded={showForm}
          aria-controls={showForm ? formId : undefined}
          aria-busy={pending || undefined}
          disabled={disabled}
          onClick={() => rate('down')}
        >
          <ThumbsDown
            aria-hidden
            strokeWidth={1.5}
            className={cn(rating === 'down' && 'fill-current')}
          />
        </Button>
        {rating === 'down' && !showForm ? (
          <Button
            type="button"
            variant="link"
            size="compact"
            className="px-1.5"
            disabled={busy}
            onClick={() => {
              // 以已保存的内容为起点修改
              setComment(current?.comment ?? '')
              setReason(current?.reason ?? null)
              setShare(current?.shareConversation ?? false)
              focusTextarea.current = true
              setFormOpen(true)
            }}
          >
            {labels.edit}
          </Button>
        ) : null}
        {meta ? <span className="ml-2 text-caption text-muted-foreground">{meta}</span> : null}
      </div>
      {showForm ? (
        <form
          id={formId}
          aria-labelledby={questionId}
          className="mt-1 flex flex-col gap-2.5 rounded-xl border bg-card px-4 py-3.5"
          onSubmit={(event) => {
            event.preventDefault()
            const text = comment.trim()
            void save(
              {
                rating: 'down',
                comment: text ? text : null,
                ...(reasons ? { reason } : {}),
                ...(shareLabels ? { shareConversation: share } : {}),
              },
              {
                onSuccess: () => {
                  setFormOpen(false)
                  setNotice('saved')
                  downRef.current?.focus()
                },
                // 表单保持打开，焦点回到文字框便于重试
                onFailure: () => textareaRef.current?.focus(),
              },
            )
          }}
          // 外层浮层（如 EmbeddedChat）见到该属性时不处理这次 Esc，只收起表单
          data-escape-scope=""
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.stopPropagation()
              closeForm()
            }
          }}
        >
          <span id={questionId} className="font-medium text-body">
            {labels.question}
          </span>
          {reasons && reasons.length > 0 ? (
            // biome-ignore lint/a11y/useSemanticElements: 按钮组不是表单字段，fieldset 会带入表单语义与默认最小宽度
            <div role="group" aria-labelledby={questionId} className="flex flex-wrap gap-1.5">
              {reasons.map((item) => {
                const pressed = reason === item.value
                return (
                  <button
                    key={item.value}
                    type="button"
                    aria-pressed={pressed}
                    disabled={disabled}
                    onClick={() => setReason(pressed ? null : item.value)}
                    className={cn(
                      'inline-flex h-6 cursor-pointer items-center rounded-full px-2.5 font-medium text-caption',
                      'outline-none transition-colors duration-80 focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--focus-ring)',
                      'disabled:pointer-events-none disabled:opacity-50',
                      pressed
                        ? 'bg-primary text-primary-foreground'
                        : 'text-foreground inset-ring-1 inset-ring-border hover:bg-hover',
                    )}
                  >
                    {item.label}
                  </button>
                )
              })}
            </div>
          ) : null}
          <label htmlFor={textareaId} className="text-caption text-muted-foreground">
            {labels.comment}
          </label>
          <Textarea
            ref={textareaRef}
            id={textareaId}
            rows={2}
            maxLength={commentMaxLength}
            value={comment}
            // 保存中仍可编辑，只禁用提交
            disabled={disabled}
            {...(labels.commentPlaceholder ? { placeholder: labels.commentPlaceholder } : {})}
            onChange={(event) => setComment(event.target.value)}
          />
          {shareLabels ? (
            <div className="flex items-start gap-2">
              <Checkbox
                id={shareId}
                className="mt-0.5"
                checked={share}
                // 保存中不可改，避免提交的值与界面不一致
                disabled={disabled || pending}
                aria-describedby={shareDescriptionId}
                onCheckedChange={setShare}
              />
              <div className="grid gap-0.5">
                <Label htmlFor={shareId} className="font-normal text-caption leading-normal">
                  {shareLabels.label}
                </Label>
                <p id={shareDescriptionId} className="m-0 text-caption text-muted-foreground">
                  {shareLabels.description}
                </p>
              </div>
            </div>
          ) : null}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" size="sm" disabled={pending} onClick={closeForm}>
              {labels.cancel}
            </Button>
            <Button type="submit" size="sm" loading={pending} disabled={disabled}>
              {labels.submit}
            </Button>
          </div>
        </form>
      ) : null}
      {/* status 区域始终留在无障碍树中（空时高度为 0，用负外边距抵消父级间距），保证「已保存」能被播报；
          失败用 role="alert"，带着文字插入即立即播报，平时不渲染（页面上不留空的 alert） */}
      <div className={cn('text-caption', !notice && '-mt-1')}>
        <p role="status" className="m-0 text-muted-foreground">
          {notice === 'saved' ? labels.saved : null}
        </p>
        {notice === 'failed' ? (
          <p role="alert" className="m-0 text-destructive">
            {labels.failed}
          </p>
        ) : null}
      </div>
    </div>
  )
}

export type {
  FeedbackRating,
  MessageFeedbackLabels,
  MessageFeedbackProps,
  MessageFeedbackReason,
  MessageFeedbackShareLabels,
  MessageFeedbackValue,
}
export { MessageFeedback }
