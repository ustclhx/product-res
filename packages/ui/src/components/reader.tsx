// 来源：无（模板新增，openspec add-ui-design-system tasks 8.4，design D11）。
// 长文阅读器：安全 Markdown（见 reader-markdown.tsx 与 lib/markdown.ts）、自动目录（h2 / h3）、吸顶目录与当前节高亮、
// 阅读进度、移动端目录下拉、打印样式与导出 PDF。外观与各状态按
// docs/design-system/prototypes/ui-review/Reader.dc.html、ReaderMobile.dc.html。
// 组件内没有默认文案，全部经 `labels` 与各插槽由调用方按语言传入。
// 依赖较重（react-markdown 等），只经本包的 `reader` 子路径（src/reader.ts）导出，页面用 React.lazy 按需加载。
import { BookOpen, Download, List, RotateCw } from 'lucide-react'
import {
  type ComponentProps,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import { useIcons } from '../lib/icon-context.tsx'
import {
  extractHeadingSlots,
  type MarkdownImagePolicy,
  type ReaderHeading,
} from '../lib/markdown.ts'
import { cn } from '../lib/utils.ts'
import { Alert, AlertDescription, AlertTitle } from './alert.tsx'
import { Button } from './button.tsx'
import { DropdownContent, DropdownMenu, DropdownTrigger } from './dropdown.tsx'
import { MenuItem } from './menu-item.tsx'
import { usePdfExporter } from './pdf-exporter.ts'
import { ReaderMarkdown } from './reader-markdown.tsx'

export type ReaderStatus = 'ready' | 'loading' | 'empty' | 'error'
export type ReaderImagePolicy = MarkdownImagePolicy

/** 导出按钮的文案（`ReaderExportButton` 单独使用时只需这三项） */
export interface ReaderExportLabels {
  /** 导出按钮文字（窄屏只显示图标时作为可读名称） */
  readonly exportPdf: string
  /** 注册了服务端导出后，菜单中「浏览器打印」一项 */
  readonly printPdf: string
  /** 注册了服务端导出后，菜单中「服务端生成 PDF」一项 */
  readonly serverPdf: string
}

export interface ReaderLabels extends ReaderExportLabels {
  /** 目录标题，兼作目录导航的可读名称 */
  readonly toc: string
  /** 阅读进度条的可读名称 */
  readonly progress: string
  /** 加载中，供读屏播报 */
  readonly loading: string
  /** 文末脚注区的标题（读屏可见） */
  readonly footnotes: string
  /** 脚注中「返回正文」链接的可读名称 */
  readonly footnoteBack: string
}

// ── 控制器：阅读进度与文档信息放在外部 store，进度条与导出按钮可以放在阅读器之外（如工作台顶栏），
//    进度变化只重渲染进度条本身，不重渲染整篇正文 ──

interface ReaderDocument {
  readonly title: string
  readonly markdown: string
  readonly ready: boolean
  readonly exportContext: unknown
}

const EMPTY_DOCUMENT: ReaderDocument = {
  title: '',
  markdown: '',
  ready: false,
  exportContext: undefined,
}

export interface ReaderController {
  /** @internal */
  readonly subscribe: (listener: () => void) => () => void
  /** @internal */
  readonly getProgress: () => number
  /** @internal */
  readonly setProgress: (value: number) => void
  /** @internal */
  readonly getDocument: () => ReaderDocument
  /** @internal */
  readonly setDocument: (document: ReaderDocument) => void
}

function createReaderController(): ReaderController {
  let progress = 0
  let doc = EMPTY_DOCUMENT
  const listeners = new Set<() => void>()
  const emit = () => {
    for (const listener of listeners) listener()
  }
  return {
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    getProgress: () => progress,
    setProgress(value) {
      if (value === progress) return
      progress = value
      emit()
    },
    getDocument: () => doc,
    setDocument(next) {
      if (
        next.title === doc.title &&
        next.markdown === doc.markdown &&
        next.ready === doc.ready &&
        next.exportContext === doc.exportContext
      ) {
        return
      }
      doc = next
      emit()
    },
  }
}

/**
 * 在页面中创建阅读器控制器，同时传给 `<Reader controller bar={false}>` 与放在外部顶栏中的
 * `ReaderProgress`、`ReaderExportButton`。控制器在组件生命周期内保持不变。
 */
export function useReaderController(): ReaderController {
  return useState(createReaderController)[0]
}

function useProgress(controller: ReaderController) {
  return useSyncExternalStore(controller.subscribe, controller.getProgress, () => 0)
}

function useReaderDocument(controller: ReaderController) {
  return useSyncExternalStore(controller.subscribe, controller.getDocument, () => EMPTY_DOCUMENT)
}

export interface ReaderProgressProps extends Omit<ComponentProps<'div'>, 'children'> {
  readonly controller: ReaderController
  /** 进度条的可读名称 */
  readonly label: string
}

/** 阅读进度条（2px，强调色）。默认铺满容器宽度，由调用方定位（如顶栏底边） */
export function ReaderProgress({ controller, label, className, ...props }: ReaderProgressProps) {
  const progress = useProgress(controller)
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={progress}
      data-slot="reader-progress"
      className={cn('h-0.5 w-full print:hidden', className)}
      {...props}
    >
      <div
        className="h-full rounded-r-xs bg-primary transition-[width] duration-100 motion-reduce:transition-none"
        style={{ width: `${progress}%` }}
      />
    </div>
  )
}

export interface ReaderExportButtonProps {
  readonly controller: ReaderController
  readonly labels: ReaderExportLabels
  /** 服务端导出失败时调用；未传时错误只在控制台输出 */
  readonly onError?: ((error: unknown) => void) | undefined
  readonly className?: string
}

/**
 * 导出 PDF：未注册服务端实现时直接调用浏览器打印；`registerPdfExporter` 注册后变为「浏览器打印 / 服务端生成」菜单。
 * 阅读器不在正常状态（加载、空、错误）时禁用。窄屏只显示图标。
 */
export function ReaderExportButton({
  controller,
  labels,
  onError,
  className,
}: ReaderExportButtonProps) {
  const exporter = usePdfExporter()
  const doc = useReaderDocument(controller)
  const [busy, setBusy] = useState(false)
  const disabled = !doc.ready
  // 窄屏只显示图标（画板 ReaderMobile 为无边框图标按钮），宽屏为带文字的描边按钮
  const button = (
    <Button
      type="button"
      variant="outline"
      size="sm"
      leadingIcon={Download}
      loading={busy}
      disabled={disabled}
      aria-label={labels.exportPdf}
      data-slot="reader-export"
      className={cn('max-md:size-9 max-md:before:ring-0 print:hidden', className)}
      {...(exporter ? {} : { onClick: () => window.print() })}
    >
      <span className="max-md:sr-only">{labels.exportPdf}</span>
    </Button>
  )
  if (!exporter || disabled) return button

  async function exportOnServer(run: NonNullable<typeof exporter>) {
    setBusy(true)
    try {
      await run({ title: doc.title, markdown: doc.markdown, exportContext: doc.exportContext })
    } catch (error) {
      if (onError) onError(error)
      else console.error(error)
    } finally {
      setBusy(false)
    }
  }

  return (
    <DropdownMenu>
      <DropdownTrigger render={button} />
      <DropdownContent align="end">
        <MenuItem index={0} label={labels.printPdf} onSelect={() => window.print()} />
        <MenuItem index={1} label={labels.serverPdf} onSelect={() => exportOnServer(exporter)} />
      </DropdownContent>
    </DropdownMenu>
  )
}

export interface ReaderProps extends Omit<ComponentProps<'div'>, 'title' | 'children'> {
  /** 文档标题：显示在顶栏与正文开头，也传给服务端导出 */
  readonly title: string
  /** Markdown 源文；只在 `status="ready"` 时渲染 */
  readonly markdown?: string
  readonly status?: ReaderStatus
  readonly labels: ReaderLabels
  /**
   * 是否显示自带顶栏（标题、导出、进度）。默认显示，适合独立页面；放进已有顶栏的外壳（如工作台）时传 `false`，
   * 并用同一个 `controller` 在外壳顶栏里放 `ReaderProgress` 与 `ReaderExportButton`。
   */
  readonly bar?: boolean
  /** 与外部 `ReaderProgress` / `ReaderExportButton` 共享状态时传入（见 `useReaderController`） */
  readonly controller?: ReaderController
  /** 顶栏标题前的内容：宽屏放面包屑，窄屏放返回按钮（仅自带顶栏时） */
  readonly leading?: ReactNode
  /** 顶栏导出按钮后的操作（通知、明暗切换等；仅自带顶栏时） */
  readonly actions?: ReactNode
  /** 标题下方的说明行（来源、日期、阅读时长、标签等） */
  readonly meta?: ReactNode
  /** `status="empty"` 时显示，通常为 `ReaderEmpty` */
  readonly emptyState?: ReactNode
  /** `status="error"` 时显示，通常为 `ReaderError` */
  readonly errorState?: ReactNode
  /** 正文之后的插槽（如嵌入式对话、悬浮提问入口）；打印时隐藏 */
  readonly footer?: ReactNode
  /** 正文图片：`same-origin`（默认，只显示站内相对地址）、`all`（另允许 http/https）、`none` */
  readonly images?: ReaderImagePolicy
  /** 原样传给服务端导出实现（如报告 id），阅读器不读取 */
  readonly exportContext?: unknown
  /** 服务端导出失败时调用；未传时错误只在控制台输出 */
  readonly onPdfExportError?: (error: unknown) => void
  /**
   * 读者经目录跳到某节后调用（参数为标题 id）。阅读器不改地址栏：TanStack Router 把 `history.replaceState`
   * 当作导航并重跑 beforeLoad / loader（tasks 8.4 评审 S12 在整页预览中验证），需要同步 hash 时由应用处理。
   */
  readonly onSectionChange?: (id: string) => void
}

// 服务端渲染没有布局副作用，用 useEffect 避免 React 的 useLayoutEffect 警告
const useIsomorphicLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect

/** 吸顶物（顶栏、移动端目录条）之下再留出的距离：标题越过这条线即视为进入该节 */
const ACTIVE_OFFSET = 32
const USER_SCROLL_KEYS = new Set(['ArrowDown', 'ArrowUp', 'PageDown', 'PageUp', 'Home', 'End', ' '])
/** 点击目录后，滚动停止这么久（或一直没有滚动）即解除高亮锁定 */
const SETTLE_MS = 200
const TOC_SELECTOR = '[data-slot="reader-toc"],[data-slot="reader-mobile-toc"]'

/** 最近的纵向滚动容器；页面本身滚动时返回 null（工作台主面板等容器内滚动时用它的下沿代替视口下沿） */
function findScrollParent(el: HTMLElement): HTMLElement | null {
  let node = el.parentElement
  while (node && node !== node.ownerDocument.body && node !== node.ownerDocument.documentElement) {
    const overflow = getComputedStyle(node).overflowY
    if ((overflow === 'auto' || overflow === 'scroll') && node.scrollHeight > node.clientHeight) {
      return node
    }
    node = node.parentElement
  }
  return null
}

function prefersReducedMotion() {
  return typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
    : false
}

function headingElement(article: HTMLElement | null, id: string): HTMLElement | null {
  // id 由 slugify 生成，只含字母、数字与 `-`，可直接放进属性选择器
  return article?.querySelector<HTMLElement>(`[id="${id}"]`) ?? null
}

/**
 * 跟随滚动计算阅读进度（写入控制器）与当前节。监听捕获阶段的 scroll，页面滚动与外层滚动容器都能收到。
 * 点击目录后锁定高亮到所选标题，避免平滑滚动途经的标题闪烁；滚动停止（scrollend 或一段时间没有滚动）、
 * 读者自己滚动（滚轮、触摸、按键）或在目录外按下指针时解除锁定。停止后保持所选项，直到下一次滚动再重新计算
 * （文末几节可能滚不到顶栏下方，立即重算会落回上一节）。
 */
function useReadingPosition(
  enabled: boolean,
  headings: readonly ReaderHeading[],
  controller: ReaderController,
  articleRef: React.RefObject<HTMLElement | null>,
  stickyRef: React.RefObject<HTMLElement | null>,
  onSectionChange: ((id: string) => void) | undefined,
) {
  const onSectionChangeRef = useRef(onSectionChange)
  onSectionChangeRef.current = onSectionChange
  const [activeId, setActiveId] = useState<string | null>(headings[0]?.id ?? null)
  const lockedRef = useRef(false)
  const settleRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const scrollParentRef = useRef<HTMLElement | null>(null)

  const measure = useCallback(() => {
    const article = articleRef.current
    if (!enabled || !article) {
      controller.setProgress(0)
      return
    }
    const container = scrollParentRef.current
    const viewport = container
      ? Math.min(container.getBoundingClientRect().bottom, window.innerHeight)
      : window.innerHeight
    const top = (stickyRef.current?.getBoundingClientRect().bottom ?? 0) + ACTIVE_OFFSET
    const rect = article.getBoundingClientRect()
    const scrollable = rect.height - (viewport - top)
    const value =
      scrollable <= 0
        ? rect.top < viewport
          ? 100
          : 0
        : Math.round(Math.min(Math.max((top - rect.top) / scrollable, 0), 1) * 100)
    controller.setProgress(value)
    if (lockedRef.current || headings.length === 0) return
    let current = headings[0]?.id ?? null
    // 已滚到正文末尾时高亮最后一节（文末几节可能无法滚到顶栏下方）
    if (scrollable > 0 && top - rect.top >= scrollable - 1) {
      current = headings[headings.length - 1]?.id ?? current
    } else {
      for (const heading of headings) {
        const el = headingElement(article, heading.id)
        if (el && el.getBoundingClientRect().top <= top) current = heading.id
      }
    }
    setActiveId(current)
  }, [enabled, headings, controller, articleRef, stickyRef])

  const unlock = useCallback(() => {
    lockedRef.current = false
    clearTimeout(settleRef.current)
  }, [])

  useEffect(() => {
    setActiveId(headings[0]?.id ?? null)
    unlock()
  }, [headings, unlock])

  useEffect(() => {
    if (!enabled) {
      controller.setProgress(0)
      return
    }
    let frame = 0
    const schedule = () => {
      if (lockedRef.current) {
        // 平滑滚动进行中：推迟解除锁定，直到滚动停下
        clearTimeout(settleRef.current)
        settleRef.current = setTimeout(unlock, SETTLE_MS)
      }
      if (frame) return
      frame = requestAnimationFrame(() => {
        frame = 0
        measure()
      })
    }
    const userScroll = (event: Event) => {
      if (event instanceof KeyboardEvent && !USER_SCROLL_KEYS.has(event.key)) return
      if (lockedRef.current) unlock()
    }
    const pointerDown = (event: Event) => {
      if (!lockedRef.current) return
      if (event.target instanceof Element && event.target.closest(TOC_SELECTOR)) return
      unlock()
    }
    scrollParentRef.current = articleRef.current ? findScrollParent(articleRef.current) : null
    measure()
    window.addEventListener('scroll', schedule, { capture: true, passive: true })
    window.addEventListener('scrollend', unlock, { capture: true })
    window.addEventListener('resize', schedule)
    window.addEventListener('wheel', userScroll, { passive: true })
    window.addEventListener('touchstart', userScroll, { passive: true })
    window.addEventListener('keydown', userScroll)
    window.addEventListener('pointerdown', pointerDown, { capture: true })
    return () => {
      if (frame) cancelAnimationFrame(frame)
      unlock()
      window.removeEventListener('scroll', schedule, { capture: true })
      window.removeEventListener('scrollend', unlock, { capture: true })
      window.removeEventListener('resize', schedule)
      window.removeEventListener('wheel', userScroll)
      window.removeEventListener('touchstart', userScroll)
      window.removeEventListener('keydown', userScroll)
      window.removeEventListener('pointerdown', pointerDown, { capture: true })
    }
  }, [enabled, measure, unlock, controller, articleRef])

  const jumpTo = useCallback(
    (id: string) => {
      const target = headingElement(articleRef.current, id)
      if (!target) return
      lockedRef.current = true
      clearTimeout(settleRef.current)
      // 目标已在位置上时不会产生滚动，也就没有 scrollend：到时直接解除
      settleRef.current = setTimeout(unlock, SETTLE_MS + 100)
      setActiveId(id)
      target.scrollIntoView({
        behavior: prefersReducedMotion() ? 'auto' : 'smooth',
        block: 'start',
      })
      target.focus({ preventScroll: true })
      onSectionChangeRef.current?.(id)
    },
    [articleRef, unlock],
  )

  return { activeId, jumpTo }
}

/**
 * 打印时临时切到浅色：深色主题的浅色文字打在白纸上不可读。只在阅读器挂载期间监听，打印结束后还原。
 */
function usePrintInLightMode() {
  useEffect(() => {
    const root = document.documentElement
    let restore = false
    const before = () => {
      restore = root.classList.contains('dark')
      if (restore) root.classList.remove('dark')
    }
    const after = () => {
      if (restore) root.classList.add('dark')
      restore = false
    }
    window.addEventListener('beforeprint', before)
    window.addEventListener('afterprint', after)
    return () => {
      after()
      window.removeEventListener('beforeprint', before)
      window.removeEventListener('afterprint', after)
    }
  }, [])
}

function MobileToc({
  labels,
  headings,
  activeId,
  onPick,
}: {
  readonly labels: ReaderLabels
  readonly headings: readonly ReaderHeading[]
  readonly activeId: string | null
  readonly onPick: (id: string) => void
}) {
  const icons = useIcons()
  const Chevron = icons['chevron-down']
  const [open, setOpen] = useState(false)
  const panelId = useId()
  const containerRef = useRef<HTMLDivElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const current = headings.find((heading) => heading.id === activeId) ?? headings[0]

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      setOpen(false)
      buttonRef.current?.focus()
    }
    // 键盘焦点移出目录（按钮与下拉）时收起
    const container = containerRef.current
    const onFocusOut = (event: FocusEvent) => {
      if (!container?.contains(event.relatedTarget as Node | null)) setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    container?.addEventListener('focusout', onFocusOut)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
      container?.removeEventListener('focusout', onFocusOut)
    }
  }, [open])

  return (
    <div
      ref={containerRef}
      data-slot="reader-mobile-toc"
      className="relative border-border border-b bg-surface-2 px-4 py-2 lg:hidden"
    >
      <button
        ref={buttonRef}
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((value) => !value)}
        className="flex h-9 w-full items-center gap-2 rounded-lg px-3 text-body inset-ring-1 inset-ring-border outline-none hover:bg-hover focus-visible:outline-2 focus-visible:outline-(--focus-ring) focus-visible:outline-offset-2"
      >
        <List aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
        <span className="text-caption text-muted-foreground">{labels.toc}</span>
        <span className="min-w-0 flex-1 truncate text-left font-medium">{current?.text}</span>
        <Chevron
          size={16}
          className={cn(
            'shrink-0 text-muted-foreground transition-transform duration-150 motion-reduce:transition-none',
            open && 'rotate-180',
          )}
        />
      </button>
      {open ? (
        <nav
          id={panelId}
          aria-label={labels.toc}
          className="absolute inset-x-4 top-12 z-(--z-popover) max-h-[60vh] overflow-y-auto rounded-xl bg-popover py-1 text-popover-foreground shadow-surface-4"
        >
          {headings.map((heading) => {
            const active = heading.id === current?.id
            return (
              <a
                key={heading.id}
                href={`#${heading.id}`}
                aria-current={active ? 'location' : undefined}
                onClick={(event) => {
                  event.preventDefault()
                  setOpen(false)
                  onPick(heading.id)
                }}
                className={cn(
                  'block px-4 py-2.5 text-body outline-none hover:bg-hover focus-visible:outline-2 focus-visible:outline-(--focus-ring) focus-visible:-outline-offset-2',
                  heading.level === 3 && 'pl-8',
                  active ? 'bg-active font-medium text-foreground' : 'text-muted-foreground',
                )}
              >
                {heading.text}
              </a>
            )
          })}
        </nav>
      ) : null}
    </div>
  )
}

function Skeleton({ className }: { readonly className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'block animate-pulse rounded-md bg-active motion-reduce:animate-none',
        className,
      )}
    />
  )
}

const SKELETON_LINES = [
  'w-full',
  'w-11/12',
  'w-5/6',
  'w-full',
  'w-3/4',
  'w-11/12',
  'w-full',
  'w-5/6',
  'w-3/5',
  'w-full',
  'w-11/12',
  'w-2/3',
]

/**
 * 长文阅读器。放在可滚动的页面或容器中：自带顶栏（标题、导出、阅读进度，可用 `bar={false}` 关闭）与移动端目录条吸顶，
 * 宽屏左侧为吸顶目录。正文中的原始 HTML 一律丢弃，链接只允许 http、https 与站内地址，图片按 `images` 策略。
 * 每种状态恰好一个 h1：正常状态为正文标题，其余状态为顶栏标题（无顶栏时为仅读屏可见的标题）。
 * 打印时隐藏顶栏、目录与 `footer` 插槽，二级标题从新页开始，深色主题临时切为浅色。
 */
export function Reader({
  title,
  markdown = '',
  status = 'ready',
  labels,
  bar = true,
  controller: externalController,
  leading,
  actions,
  meta,
  emptyState,
  errorState,
  footer,
  images = 'same-origin',
  exportContext,
  onPdfExportError,
  onSectionChange,
  className,
  ...props
}: ReaderProps) {
  const ready = status === 'ready'
  const ownController = useReaderController()
  const controller = externalController ?? ownController
  const slots = useMemo(() => (ready ? extractHeadingSlots(markdown) : []), [ready, markdown])
  const headings = useMemo(() => slots.filter((heading) => heading.text !== ''), [slots])
  const articleRef = useRef<HTMLElement>(null)
  const stickyRef = useRef<HTMLDivElement>(null)
  const { activeId, jumpTo } = useReadingPosition(
    ready,
    headings,
    controller,
    articleRef,
    stickyRef,
    onSectionChange,
  )
  usePrintInLightMode()

  // 客户端在绘制前同步，外部导出按钮首帧即可用
  useIsomorphicLayoutEffect(() => {
    controller.setDocument({ title, markdown, ready, exportContext })
  }, [controller, title, markdown, ready, exportContext])

  return (
    <div
      data-slot="reader"
      data-status={status}
      data-bar={bar}
      className={cn(
        'group/reader flex min-h-full flex-col bg-surface-2 text-body text-foreground print:bg-transparent',
        className,
      )}
      {...props}
    >
      <div
        ref={stickyRef}
        data-slot="reader-bar"
        className="sticky top-0 z-(--z-sticky) print:hidden"
      >
        {bar ? (
          <header className="relative flex h-14 items-center gap-1 border-border border-b bg-surface-2 px-2 md:gap-2 md:pr-4 md:pl-6">
            <div className="flex min-w-0 flex-1 items-center gap-1 md:gap-1.5">
              {leading}
              {ready ? (
                <p className="min-w-0 truncate font-semibold text-title">{title}</p>
              ) : (
                <h1 className="min-w-0 truncate font-semibold text-title">{title}</h1>
              )}
            </div>
            <ReaderExportButton
              controller={controller}
              labels={labels}
              onError={onPdfExportError}
            />
            {actions}
            <ReaderProgress
              controller={controller}
              label={labels.progress}
              className="absolute inset-x-0 -bottom-px"
            />
          </header>
        ) : null}
        {ready && headings.length > 0 ? (
          <MobileToc labels={labels} headings={headings} activeId={activeId} onPick={jumpTo} />
        ) : null}
      </div>
      {!bar && !ready ? <h1 className="sr-only">{title}</h1> : null}

      <div className="mx-auto grid w-full max-w-[66rem] items-start gap-12 px-4 pt-5 pb-24 lg:grid-cols-[13rem_minmax(0,1fr)] lg:px-8 lg:pt-8 lg:pb-16 print:block print:max-w-none print:p-0">
        {/* 滚动放在外层、左边线放在内层：当前项向左 1px 的 2px 标记不会被滚动容器裁掉 */}
        <nav
          aria-label={labels.toc}
          data-slot="reader-toc"
          className="sticky top-20 hidden max-h-[calc(100vh-7rem)] overflow-y-auto group-data-[bar=false]/reader:top-6 lg:block print:hidden"
        >
          <div className="flex flex-col gap-0.5 border-border border-l">
            <span className="px-3 pb-1.5 font-medium text-caption text-muted-foreground">
              {labels.toc}
            </span>
            {status === 'loading' ? (
              <span className="flex flex-col gap-3 px-3 py-1.5">
                <Skeleton className="h-2.5 w-[70%]" />
                <Skeleton className="h-2.5 w-[85%]" />
                <Skeleton className="h-2.5 w-3/5" />
              </span>
            ) : null}
            {headings.map((heading) => {
              const active = heading.id === activeId
              return (
                <a
                  key={heading.id}
                  href={`#${heading.id}`}
                  aria-current={active ? 'location' : undefined}
                  onClick={(event) => {
                    event.preventDefault()
                    jumpTo(heading.id)
                  }}
                  className={cn(
                    '-ml-px block border-l-2 py-1 pr-3 text-body outline-none transition-colors duration-100 hover:text-foreground focus-visible:outline-2 focus-visible:outline-(--focus-ring) focus-visible:-outline-offset-2',
                    heading.level === 3 ? 'pl-6' : 'pl-3',
                    active
                      ? 'border-primary font-medium text-foreground'
                      : 'border-transparent text-muted-foreground',
                  )}
                >
                  {heading.text}
                </a>
              )
            })}
          </div>
        </nav>

        <div className="flex min-w-0 flex-col gap-10">
          {status === 'loading' ? (
            <div aria-busy="true" className="flex max-w-[45rem] flex-col gap-3 md:gap-3.5">
              <span className="sr-only" role="status">
                {labels.loading}
              </span>
              <Skeleton className="h-6.5 w-4/5 md:h-7.5 md:w-3/5" />
              <Skeleton className="h-3 w-1/2 md:w-2/5" />
              <span className="h-3 md:h-4" />
              {SKELETON_LINES.map((width, index) => (
                <Skeleton
                  // biome-ignore lint/suspicious/noArrayIndexKey: 固定长度的占位行，无身份
                  key={index}
                  className={cn('h-3', width, index >= 10 && 'max-md:hidden')}
                />
              ))}
            </div>
          ) : null}
          {status === 'empty' ? emptyState : null}
          {status === 'error' ? errorState : null}
          {ready ? (
            <article
              ref={articleRef}
              data-slot="reader-article"
              className="min-w-0 max-w-[45rem] wrap-break-word text-body leading-6 print:max-w-none"
            >
              <header className="mb-2 flex flex-col gap-1.5 md:gap-2">
                <h1 className="m-0 font-semibold text-(length:--fs-display-compact) leading-(--lh-display-compact) tracking-[-0.01em] md:text-display">
                  {title}
                </h1>
                {meta ? (
                  <div className="flex flex-wrap items-center gap-2 text-caption text-muted-foreground">
                    {meta}
                  </div>
                ) : null}
              </header>
              <ReaderMarkdown
                markdown={markdown}
                slots={slots}
                title={title}
                images={images}
                footnoteLabel={labels.footnotes}
                footnoteBackLabel={labels.footnoteBack}
              />
            </article>
          ) : null}
          {ready && footer ? (
            <div data-slot="reader-footer" className="max-w-[45rem] print:hidden">
              {footer}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  )
}

export interface ReaderEmptyProps {
  readonly title: string
  readonly description?: string
  /** 主操作，如「生成报告」按钮 */
  readonly action?: ReactNode
}

/** 阅读器空状态：虚线框图示、标题、说明与主操作 */
export function ReaderEmpty({ title, description, action }: ReaderEmptyProps) {
  return (
    <div className="flex max-w-[45rem] flex-col items-center gap-2.5 px-4 pt-24 text-center md:pb-24">
      <div
        aria-hidden="true"
        className="flex h-19 w-26 items-center justify-center rounded-xl border border-border border-dashed text-muted-foreground md:h-22 md:w-30"
      >
        <BookOpen className="size-6" strokeWidth={1.5} />
      </div>
      <h2 className="mt-1 font-semibold text-title">{title}</h2>
      {description ? <p className="max-w-sm text-muted-foreground">{description}</p> : null}
      {action ? <div className="mt-1">{action}</div> : null}
    </div>
  )
}

export interface ReaderErrorProps {
  readonly title: string
  readonly description?: string
  /** 传入时显示重试按钮 */
  readonly retryLabel?: string
  readonly onRetry?: () => void
}

/** 阅读器错误状态：说明正文暂时无法读取，并提供重试 */
export function ReaderError({ title, description, retryLabel, onRetry }: ReaderErrorProps) {
  const icons = useIcons()
  const AlertIcon = icons['circle-alert']
  return (
    <Alert variant="destructive" className="max-w-[45rem]">
      <AlertIcon size={16} />
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription className="gap-2.5 text-destructive">
        {description ? <p>{description}</p> : null}
        {retryLabel && onRetry ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            leadingIcon={RotateCw}
            onClick={onRetry}
          >
            {retryLabel}
          </Button>
        ) : null}
      </AlertDescription>
    </Alert>
  )
}
