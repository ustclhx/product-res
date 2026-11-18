import { Badge, Button, Switch, Tabs, TabsItem } from '@product-res/ui'
import { ChevronLeft, ChevronRight, Sparkles } from '@product-res/ui/icons'
import {
  Reader,
  type ReaderController,
  ReaderEmpty,
  ReaderError,
  ReaderExportButton,
  type ReaderLabels,
  ReaderProgress,
  type ReaderStatus,
  useReaderController,
} from '@product-res/ui/reader'
import { Link } from '@tanstack/react-router'
import { type ReactNode, useState } from 'react'
import { m } from '../../paraglide/messages.js'
import { getLocale } from '../../paraglide/runtime.js'
import { PreviewSection, Specimen } from './layout.tsx'
import { READER_STATUSES } from './reader-states.ts'
import { sampleReport } from './sample-reader.ts'

function statusLabel(status: ReaderStatus): string {
  switch (status) {
    case 'ready':
      return m.ui_preview_reader_state_ready()
    case 'empty':
      return m.ui_preview_reader_state_empty()
    case 'loading':
      return m.ui_preview_reader_state_loading()
    case 'error':
      return m.ui_preview_reader_state_error()
  }
}

function readerLabels(): ReaderLabels {
  return {
    toc: m.ui_preview_reader_toc(),
    progress: m.ui_preview_reader_progress(),
    exportPdf: m.ui_preview_reader_export(),
    printPdf: m.ui_preview_reader_print(),
    serverPdf: m.ui_preview_reader_server(),
    loading: m.ui_preview_reader_loading(),
    footnotes: m.ui_preview_reader_footnotes(),
    footnoteBack: m.ui_preview_reader_footnote_back(),
  }
}

/** 预览用的阅读器：示例报告与四种状态；尾部插槽按任务说明留空（嵌入式对话属于 tasks 8.6） */
export function ReaderDemo({
  status,
  actions,
  className,
  controller,
}: {
  readonly status: ReaderStatus
  readonly actions?: ReactNode
  readonly className?: string
  /** 传入时关闭自带顶栏（bar={false}），由外部顶栏放进度条与导出按钮 */
  readonly controller?: ReaderController
}) {
  return (
    <Reader
      className={className}
      {...(controller ? { controller, bar: false } : {})}
      title={m.ui_preview_reader_title()}
      markdown={sampleReport(getLocale())}
      status={status}
      labels={readerLabels()}
      leading={
        <>
          <Button asChild variant="ghost" size="icon" className="md:hidden">
            <Link to="/dev/ui" hash="reader" aria-label={m.ui_preview_reader_back()}>
              <ChevronLeft className="size-5" />
            </Link>
          </Button>
          <span className="hidden items-center gap-1.5 md:flex">
            <Link
              to="/dev/ui"
              hash="reader"
              className="text-muted-foreground hover:text-foreground hover:underline"
            >
              {m.ui_preview_reader_reports()}
            </Link>
            <ChevronRight aria-hidden="true" className="size-3.5 text-muted-foreground" />
          </span>
        </>
      }
      actions={actions}
      meta={
        <>
          <span>{m.ui_preview_reader_meta()}</span>
          <Badge size="compact">{m.ui_preview_reader_sample()}</Badge>
        </>
      }
      emptyState={
        <ReaderEmpty
          title={m.ui_preview_reader_empty_title()}
          description={m.ui_preview_reader_empty_desc()}
          action={<Button leadingIcon={Sparkles}>{m.ui_preview_reader_generate()}</Button>}
        />
      }
      errorState={
        <ReaderError
          title={m.ui_preview_reader_error_title()}
          description={m.ui_preview_reader_error_desc()}
          retryLabel={m.ui_preview_reader_retry()}
          onRetry={() => {}}
        />
      }
    />
  )
}

/** 外壳顶栏示例：工作台等已有顶栏的页面关闭阅读器自带顶栏，把进度条与导出按钮放进自己的顶栏 */
function ShellBarDemo({ status }: { readonly status: ReaderStatus }) {
  const controller = useReaderController()
  return (
    <div className="flex h-full flex-col">
      <header className="relative flex h-12 shrink-0 items-center gap-2 border-b bg-surface-1 px-4">
        <span className="min-w-0 flex-1 truncate font-medium text-body">
          {m.ui_preview_reader_shell_title()}
        </span>
        <ReaderExportButton controller={controller} labels={readerLabels()} />
        <ReaderProgress
          controller={controller}
          label={m.ui_preview_reader_progress()}
          className="absolute inset-x-0 -bottom-px"
        />
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <ReaderDemo status={status} controller={controller} />
      </div>
    </div>
  )
}

export function ReaderSection() {
  const [index, setIndex] = useState(0)
  const [shellBar, setShellBar] = useState(false)
  const status = READER_STATUSES[index] ?? 'ready'
  return (
    <PreviewSection id="reader" title="Reader" description={m.ui_preview_reader_desc()}>
      <Specimen label={m.ui_preview_states()} wide className="flex-col items-stretch p-0">
        <div className="flex flex-wrap items-center justify-between gap-3 px-4 pt-4">
          <Tabs
            aria-label={m.ui_preview_reader_states()}
            idPrefix="preview-reader"
            selectedIndex={index}
            onSelect={setIndex}
          >
            {READER_STATUSES.map((value, i) => (
              <TabsItem key={value} index={i} label={statusLabel(value)} />
            ))}
          </Tabs>
          <div className="flex flex-wrap items-center gap-4">
            <Switch
              checked={shellBar}
              onToggle={() => setShellBar((value) => !value)}
              label={m.ui_preview_reader_shell_bar()}
            />
            <Button asChild variant="link">
              <Link to="/dev/ui/reader" search={{ state: status }}>
                {m.ui_preview_reader_open_full()}
              </Link>
            </Button>
          </div>
        </div>
        <div className="h-144 overflow-hidden rounded-b-xl border-t">
          {shellBar ? (
            <ShellBarDemo status={status} />
          ) : (
            <div className="h-full overflow-y-auto">
              <ReaderDemo status={status} />
            </div>
          )}
        </div>
      </Specimen>
    </PreviewSection>
  )
}
