import { Button, Label } from '@product-res/ui'
import { Link, useNavigate } from '@tanstack/react-router'
import { useState } from 'react'
import { m } from '../../paraglide/messages.js'
import { FormAlert } from '../auth/auth-layout.tsx'
import { HydratedControls } from '../workspace/components.tsx'
import { fileUploadActions, type MediaFile, submitMediaTask, uploadMediaFile } from './client.ts'
import type { getMediaSubmitPage } from './page.functions.ts'
import { MediaParameterFields } from './parameter-form.tsx'
import {
  initialMediaParams,
  type MediaModel,
  type MediaParams,
  mediaCreditEstimate,
  parseMediaSchema,
  validateMediaParams,
} from './schema.ts'

export function MediaSubmitPage({
  page,
}: {
  page: Awaited<ReturnType<typeof getMediaSubmitPage>>
}) {
  const [modelKey, setModelKey] = useState(page.models[0]?.key)
  const [busy, setBusy] = useState(false)
  const [files, setFiles] = useState<MediaFile[]>(page.files)
  const model = page.models.find((model) => model.key === modelKey)
  return (
    <div className="grid gap-6">
      <h2 className="text-2xl font-semibold">{m.media_title()}</h2>
      {model ? (
        <>
          <Label htmlFor="media-model">{m.media_model()}</Label>
          <select
            id="media-model"
            className="rounded-md border p-2"
            value={modelKey}
            disabled={busy}
            onChange={(event) => setModelKey(event.target.value)}
          >
            {page.models.map((model) => (
              <option key={model.key} value={model.key}>
                {model.key} · {model.kind === 'image' ? m.media_image() : m.media_video()}
              </option>
            ))}
          </select>
          <ModelForm
            key={model.key}
            model={model}
            page={page}
            files={files}
            onFileReady={(file) => setFiles((old) => [...old, file])}
            onBusyChange={setBusy}
          />
        </>
      ) : (
        <p role="status">{m.media_empty()}</p>
      )}
    </div>
  )
}

function ModelForm({
  model,
  page,
  onBusyChange,
  files,
  onFileReady,
}: {
  model: MediaModel
  page: Awaited<ReturnType<typeof getMediaSubmitPage>>
  onBusyChange: (busy: boolean) => void
  files: readonly MediaFile[]
  onFileReady: (file: MediaFile) => void
}) {
  let schema: ReturnType<typeof parseMediaSchema>
  let defaults: MediaParams
  try {
    schema = parseMediaSchema(model.paramsSchema === null ? null : JSON.parse(model.paramsSchema))
    defaults = initialMediaParams(schema)
  } catch {
    return <p role="alert">{m.media_unsupported()}</p>
  }
  return (
    <ParameterForm
      model={model}
      schema={schema}
      defaults={defaults}
      page={page}
      onBusyChange={onBusyChange}
      files={files}
      onFileReady={onFileReady}
    />
  )
}

function ParameterForm({
  model,
  schema,
  defaults,
  page,
  onBusyChange,
  files,
  onFileReady,
}: {
  model: MediaModel
  schema: ReturnType<typeof parseMediaSchema>
  defaults: MediaParams
  page: Awaited<ReturnType<typeof getMediaSubmitPage>>
  onBusyChange: (busy: boolean) => void
  files: readonly MediaFile[]
  onFileReady: (file: MediaFile) => void
}) {
  const [params, setParams] = useState(defaults)
  const [errors, setErrors] = useState<Record<string, string[]>>({})
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [uploading, setUploading] = useState<string>()
  const [taskId, setTaskId] = useState<string>()
  const navigate = useNavigate()
  const busy = pending || uploading !== undefined
  let credits: number | undefined
  try {
    const validated = validateMediaParams(
      schema,
      params,
      files,
      model.kind === 'image' ? 'image' : 'video',
    )
    if (validated.success) credits = mediaCreditEstimate(model, schema, validated.data)
  } catch {
    // 缺少计费用量或倍率配置不合法时不给出误导性的预计值。
  }

  function change(name: string, value: string | number | boolean | undefined) {
    setParams((previous) => {
      const next = { ...previous }
      if (value === undefined) delete next[name]
      else next[name] = value
      return next
    })
    setErrors((previous) => ({ ...previous, [name]: [] }))
    setTaskId(undefined)
  }

  async function upload(name: string, file: File) {
    if (busy || page.readOnly) return
    setUploading(name)
    onBusyChange(true)
    setError(null)
    try {
      const ready = await uploadMediaFile(page.workspaceId, file, fileUploadActions)
      onFileReady(ready)
      change(name, ready.id)
    } catch (cause) {
      setError(mediaErrorMessage(cause, true))
    } finally {
      setUploading(undefined)
      onBusyChange(false)
    }
  }

  async function submit() {
    if (busy || page.readOnly || taskId) return
    setError(null)
    const validated = validateMediaParams(
      schema,
      params,
      files,
      model.kind === 'image' ? 'image' : 'video',
    )
    if (!validated.success) {
      const errors: Record<string, string[]> = {}
      for (const issue of validated.error.issues)
        errors[String(issue.path[0])] = [m.media_invalid()]
      setErrors(errors)
      return
    }
    if (credits === undefined) return
    setPending(true)
    onBusyChange(true)
    try {
      const result = await submitMediaTask({
        workspaceId: page.workspaceId,
        modelKey: model.key,
        params: validated.data,
      })
      setTaskId(result.taskId)
      await navigate({
        to: '/app/$slug/tasks/$taskId',
        params: { slug: page.workspaceSlug, taskId: result.taskId },
      })
    } catch (cause) {
      setError(mediaErrorMessage(cause))
    } finally {
      setPending(false)
      onBusyChange(false)
    }
  }

  return (
    <form
      className="grid gap-4"
      noValidate
      onSubmit={(event) => {
        event.preventDefault()
        void submit()
      }}
    >
      {page.readOnly ? <p role="status">{m.media_readonly()}</p> : null}
      <HydratedControls>
        <fieldset disabled={busy || page.readOnly} className="grid gap-4">
          <MediaParameterFields
            schema={schema}
            params={params}
            files={files}
            errors={errors}
            uploading={uploading}
            onChange={change}
            onUpload={(name, file) => void upload(name, file)}
          />
        </fieldset>
        <p className="text-muted-foreground text-sm">
          {m.media_quota({ bytes: files.reduce((sum, file) => sum + file.size, 0) })}
        </p>
        <p data-testid="media-credit-estimate">
          {credits === undefined ? m.media_unavailable() : m.media_estimate({ credits })}
        </p>
        <Button
          type="submit"
          disabled={busy || page.readOnly || Boolean(taskId)}
          aria-busy={pending}
        >
          {pending ? m.media_submitting() : m.media_submit()}
        </Button>
      </HydratedControls>
      <FormAlert message={error} />
      {taskId ? (
        <Link
          to="/app/$slug/tasks/$taskId"
          params={{ slug: page.workspaceSlug, taskId }}
          className="underline"
        >
          {m.media_tasks_detail()}
        </Link>
      ) : null}
    </form>
  )
}

function mediaErrorMessage(cause: unknown, upload = false) {
  const code =
    cause instanceof Error && 'code' in cause
      ? cause.code
      : cause instanceof Error
        ? cause.message
        : undefined
  if (code === 'INSUFFICIENT_CREDITS' || code === 'CREDIT_DEBT') return m.media_credits_error()
  if (code === 'UPGRADE_REQUIRED') return m.media_upgrade_error()
  if (code === 'QUOTA_EXCEEDED') return m.media_quota_error()
  if (code === 'STORAGE_UNAVAILABLE') return m.media_storage_error()
  return upload ? m.media_upload_error() : m.media_error()
}
