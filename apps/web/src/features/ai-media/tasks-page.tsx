import { Button, Input, Label } from '@product-res/ui'
import { Link } from '@tanstack/react-router'
import { useEffect, useRef, useState } from 'react'
import { m } from '../../paraglide/messages.js'
import { getLocale } from '../../paraglide/runtime.js'
import { createFileShareToken, revokeFileShareToken } from '../files/files.functions.ts'
import type { WorkspacePage } from '../workspace/components.tsx'
import { pollMediaTask } from './polling.ts'
import {
  cancelMediaTask,
  getMediaTask,
  listMediaTasks,
  type MediaTask,
  type MediaTaskFile,
  type MediaTaskPage,
} from './tasks-client.ts'

function statusText(status: MediaTask['status']) {
  switch (status) {
    case 'queued':
      return m.media_tasks_queued()
    case 'running':
      return m.media_tasks_running()
    case 'succeeded':
      return m.media_tasks_succeeded()
    case 'failed':
      return m.media_tasks_failed()
    case 'canceled':
      return m.media_tasks_canceled()
  }
}

function TaskTime({ value }: { value: string | null }) {
  return value ? (
    <time dateTime={value}>
      {new Intl.DateTimeFormat(getLocale(), {
        dateStyle: 'medium',
        timeStyle: 'short',
      }).format(new Date(value))}
    </time>
  ) : (
    <>—</>
  )
}

export function MediaTasksPage({ page }: { page: WorkspacePage }) {
  const [result, setResult] = useState<MediaTaskPage>()
  const [cursor, setCursor] = useState<string>()
  const [history, setHistory] = useState<(string | undefined)[]>([])
  const [busy, setBusy] = useState(true)
  const [error, setError] = useState('')
  const [reload, setReload] = useState(0)
  // biome-ignore lint/correctness/useExhaustiveDependencies: reload 是用户手动刷新请求的触发计数。
  useEffect(() => {
    const request = new AbortController()
    setBusy(true)
    setError('')
    void listMediaTasks(page.workspace.id, cursor, request.signal)
      .then((value) => {
        if (!request.signal.aborted) setResult(value)
      })
      .catch(() => {
        if (!request.signal.aborted) setError(m.media_tasks_load_error())
      })
      .finally(() => {
        if (!request.signal.aborted) setBusy(false)
      })
    return () => request.abort()
  }, [page.workspace.id, cursor, reload])

  return (
    <section className="grid gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-2xl font-semibold">{m.media_tasks_title()}</h2>
        <Link
          to="/app/$slug/media/new"
          params={{ slug: page.workspace.slug }}
          className="underline"
        >
          {m.media_title()}
        </Link>
      </div>
      <Button disabled={busy} onClick={() => setReload((value) => value + 1)}>
        {m.media_tasks_refresh()}
      </Button>
      {busy ? <p role="status">{m.media_tasks_loading()}</p> : null}
      {error ? <p role="alert">{error}</p> : null}
      {result && !busy && !error ? (
        <>
          <div className="overflow-x-auto">
            <table className="w-full text-left">
              <caption className="sr-only">{m.media_tasks_title()}</caption>
              <thead>
                <tr>
                  <th className="p-2">{m.media_tasks_task()}</th>
                  <th className="p-2">{m.media_tasks_status()}</th>
                  <th className="p-2">{m.media_model()}</th>
                  <th className="p-2">{m.media_tasks_credits()}</th>
                  <th className="p-2">{m.media_tasks_created()}</th>
                </tr>
              </thead>
              <tbody>
                {result.items.map((task) => (
                  <tr key={task.id} className="border-t">
                    <td className="p-2">
                      <Link
                        to="/app/$slug/tasks/$taskId"
                        params={{ slug: page.workspace.slug, taskId: task.id }}
                        className="underline"
                      >
                        {task.id}
                      </Link>
                    </td>
                    <td className="p-2">{statusText(task.status)}</td>
                    <td className="p-2">{task.modelKey}</td>
                    <td className="p-2">{task.creditsCharged ?? '—'}</td>
                    <td className="p-2">
                      <TaskTime value={task.createdAt} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {result.items.length === 0 ? <p>{m.media_tasks_empty()}</p> : null}
        </>
      ) : null}
      <div className="flex gap-3">
        <Button
          disabled={busy || history.length === 0}
          onClick={() => {
            setCursor(history.at(-1))
            setHistory((values) => values.slice(0, -1))
          }}
        >
          {m.media_tasks_newer()}
        </Button>
        <Button
          disabled={busy || Boolean(error) || !result?.nextCursor}
          onClick={() => {
            if (!result?.nextCursor) return
            setHistory((values) => [...values, cursor])
            setCursor(result.nextCursor)
          }}
        >
          {m.media_tasks_older()}
        </Button>
      </div>
    </section>
  )
}

export function MediaTaskDetailPage({ page, taskId }: { page: WorkspacePage; taskId: string }) {
  const [task, setTask] = useState<MediaTask>()
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [cancelPending, setCancelPending] = useState(false)
  const polling = useRef<ReturnType<typeof pollMediaTask<MediaTask>> | null>(null)
  useEffect(() => {
    const poll = pollMediaTask({
      load: (signal) => getMediaTask(page.workspace.id, taskId, signal),
      onTask: (task) => {
        setTask(task)
        setError('')
        setCancelPending(task.errorCode === 'MEDIA_CANCEL_PENDING')
      },
      onError: (cause) =>
        setError(
          cause instanceof Error && cause.message === 'NOT_FOUND'
            ? m.media_tasks_not_found()
            : m.media_tasks_load_error(),
        ),
    })
    polling.current = poll
    return () => {
      poll.stop()
      polling.current = null
    }
  }, [page.workspace.id, taskId])
  async function cancel() {
    setBusy(true)
    setError('')
    try {
      const result = await cancelMediaTask(page.workspace.id, taskId)
      setCancelPending(result.cancellationPending)
      // 取消已落库再读取最新详情，避免旧的进行中轮询响应覆盖终态。
      polling.current?.refresh()
    } catch {
      setError(m.media_tasks_cancel_error())
    } finally {
      setBusy(false)
    }
  }
  const owner = task?.userId === page.user.id
  return (
    <section className="grid gap-5">
      <Link to="/app/$slug/tasks" params={{ slug: page.workspace.slug }} className="underline">
        {m.media_tasks_back()}
      </Link>
      <h2 className="text-2xl font-semibold">{m.media_tasks_detail()}</h2>
      <p className="break-all">{taskId}</p>
      {error ? <p role="alert">{error}</p> : null}
      <Button disabled={busy} onClick={() => polling.current?.refresh()}>
        {m.media_tasks_refresh()}
      </Button>
      {!task && !error ? <p role="status">{m.media_tasks_loading()}</p> : null}
      {task ? (
        <>
          <p role="status" data-testid="media-task-status">
            {statusText(task.status)}
          </p>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2">
            <dt>{m.media_model()}</dt>
            <dd>{task.modelKey}</dd>
            <dt>{m.media_tasks_credits()}</dt>
            <dd>{task.creditsCharged ?? '—'}</dd>
            <dt>{m.media_tasks_created()}</dt>
            <dd>
              <TaskTime value={task.createdAt} />
            </dd>
            <dt>{m.media_tasks_started()}</dt>
            <dd>
              <TaskTime value={task.startedAt} />
            </dd>
            <dt>{m.media_tasks_finished()}</dt>
            <dd>
              <TaskTime value={task.finishedAt} />
            </dd>
          </dl>
          {(task.canCancel || (owner && cancelPending)) && !page.readOnly ? (
            <Button disabled={busy} onClick={() => void cancel()}>
              {busy
                ? m.media_tasks_canceling()
                : cancelPending
                  ? m.media_tasks_cancel_retry()
                  : m.media_tasks_cancel()}
            </Button>
          ) : null}
          {cancelPending ? <p role="status">{m.media_tasks_cancel_pending()}</p> : null}
          {task.status === 'failed' ? (
            <div role="alert" className="grid gap-2">
              <p>{m.media_tasks_refunded()}</p>
              {task.errorCode === 'MEDIA_SUBMISSION_UNCERTAIN' ? (
                <p>{m.media_tasks_uncertain()}</p>
              ) : null}
              <p>{task.errorMessage ?? m.media_tasks_failure_reason()}</p>
              {task.errorCode ? <p>{task.errorCode}</p> : null}
            </div>
          ) : null}
          {task.status === 'succeeded' ? (
            <section className="grid gap-4" aria-label={m.media_tasks_results()}>
              <h3 className="text-lg font-semibold">{m.media_tasks_results()}</h3>
              {task.files.map((file, index) => (
                <TaskResult
                  key={file.id}
                  file={file}
                  index={index + 1}
                  workspaceId={page.workspace.id}
                  canShare={owner && !page.readOnly}
                />
              ))}
              {task.files.length === 0 ? <p>{m.media_tasks_no_results()}</p> : null}
            </section>
          ) : null}
        </>
      ) : null}
    </section>
  )
}

function TaskResult({
  file,
  index,
  workspaceId,
  canShare,
}: {
  file: MediaTaskFile
  index: number
  workspaceId: string
  canShare: boolean
}) {
  const [path, setPath] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [previewError, setPreviewError] = useState(false)
  async function share(revoke: boolean) {
    setBusy(true)
    setError('')
    setNotice('')
    try {
      const input = { workspaceId, fileId: file.id }
      if (revoke) {
        await revokeFileShareToken({ data: input })
        setPath('')
        setNotice(m.media_tasks_share_revoked())
      } else {
        const result = await createFileShareToken({ data: input })
        setPath(new URL(result.path, window.location.origin).href)
        setNotice(m.media_tasks_share_public())
      }
    } catch {
      setError(m.media_tasks_share_error())
    } finally {
      setBusy(false)
    }
  }
  return (
    <article className="grid gap-3 rounded-lg border p-4">
      {file.mime.startsWith('image/') ? (
        <img
          src={file.downloadUrl}
          alt={m.media_tasks_output({ index })}
          className="max-h-[32rem] max-w-full rounded-md object-contain"
          onError={() => setPreviewError(true)}
        />
      ) : file.mime.startsWith('video/') ? (
        // biome-ignore lint/a11y/useMediaCaption: 生成接口没有字幕产出，不能提供虚构字幕。
        <video
          controls
          preload="metadata"
          src={file.downloadUrl}
          className="max-h-[32rem] max-w-full rounded-md"
          aria-label={m.media_tasks_output({ index })}
          onError={() => setPreviewError(true)}
        />
      ) : null}
      {previewError ? <p role="status">{m.media_tasks_preview_error()}</p> : null}
      <p>
        {file.mime} · {file.size} B
        {file.duration !== null ? ` · ${m.media_tasks_duration({ seconds: file.duration })}` : ''}
      </p>
      <a href={`${file.downloadUrl}&download=1`} className="underline">
        {m.media_tasks_download()}
      </a>
      {canShare ? (
        <>
          <div className="flex flex-wrap gap-3">
            <Button disabled={busy} onClick={() => void share(false)}>
              {m.media_tasks_share()}
            </Button>
            <Button disabled={busy} onClick={() => void share(true)}>
              {m.media_tasks_revoke()}
            </Button>
          </div>
          {path ? (
            <div className="grid gap-2">
              <Label htmlFor={`share-${file.id}`}>{m.media_tasks_share_link()}</Label>
              <Input
                id={`share-${file.id}`}
                readOnly
                value={path}
                onFocus={(event) => event.target.select()}
              />
            </div>
          ) : null}
          {notice ? <p role="status">{notice}</p> : null}
          {error ? <p role="alert">{error}</p> : null}
        </>
      ) : null}
    </article>
  )
}
