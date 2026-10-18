import { FieldErrors, Input, Label } from '@product-res/ui'
import { useId } from 'react'
import { m } from '../../paraglide/messages.js'
import type { MediaFile } from './client.ts'
import type { MediaParams, MediaSchema } from './schema.ts'

/** 文件参数仅从服务端返回或刚确认成功的 ready 文件中选择。 */
export function MediaParameterFields({
  schema,
  params,
  files,
  errors = {},
  uploading,
  onChange,
  onUpload,
}: {
  schema: MediaSchema
  params: MediaParams
  files: readonly MediaFile[]
  errors?: Record<string, string[]>
  uploading?: string | undefined
  onChange: (name: string, value: string | number | boolean | undefined) => void
  onUpload: (name: string, file: File) => void
}) {
  const prefix = useId()
  return Object.entries(schema.properties).map(([name, field]) => {
    const id = `${prefix}-${name}`
    const errorId = `${id}-error`
    const descriptionId = `${id}-description`
    const required = schema.required.includes(name)
    const common = {
      id,
      name,
      required,
      'aria-invalid': (errors[name]?.length ?? 0) > 0 || undefined,
      'aria-describedby':
        [field.description ? descriptionId : null, errors[name]?.length ? errorId : null]
          .filter(Boolean)
          .join(' ') || undefined,
    }
    const value = params[name]
    return (
      <div key={name} className="grid gap-2">
        <Label htmlFor={id}>
          {field.title ?? name}
          {required ? ' *' : ''}
        </Label>
        {field.format === 'file' ? (
          <>
            <select
              {...common}
              className="rounded-md border p-2"
              value={typeof value === 'string' ? value : ''}
              onChange={(event) => onChange(name, event.target.value || undefined)}
            >
              <option value="">{m.media_file()}</option>
              {files
                .filter((file) => file.status === 'ready')
                .map((file) => (
                  <option key={file.id} value={file.id}>
                    {file.mime} · {file.size} B · {file.id}
                  </option>
                ))}
            </select>
            <Label htmlFor={`${id}-upload`}>{m.media_upload()}</Label>
            <Input
              id={`${id}-upload`}
              type="file"
              accept="image/jpeg,image/png,image/webp,image/gif,video/mp4,video/webm"
              onChange={(event) => {
                const file = event.target.files?.[0]
                if (file) onUpload(name, file)
                event.target.value = ''
              }}
            />
            {uploading === name ? <p role="status">{m.media_uploading()}</p> : null}
          </>
        ) : field.enum ? (
          <select
            {...common}
            className="rounded-md border p-2"
            value={value === undefined ? '' : String(field.enum.indexOf(value))}
            onChange={(event) => {
              const index = event.target.value
              onChange(name, index === '' ? undefined : field.enum?.[Number(index)])
            }}
          >
            <option value="">{m.media_select()}</option>
            {field.enum.map((option, index) => (
              <option key={String(option)} value={index}>
                {String(option)}
              </option>
            ))}
          </select>
        ) : field.type === 'boolean' ? (
          <Input
            {...common}
            // required 的布尔参数允许 false，不能用 HTML required 强制勾选。
            required={false}
            type="checkbox"
            className="h-4 w-4"
            checked={value === true}
            onChange={(event) => onChange(name, event.target.checked)}
          />
        ) : field.type === 'number' || field.type === 'integer' ? (
          <Input
            {...common}
            type="number"
            min={field.minimum}
            max={field.maximum}
            step={field.multipleOf ?? (field.type === 'integer' ? 1 : 'any')}
            value={typeof value === 'number' ? value : ''}
            onChange={(event) =>
              onChange(name, event.target.value === '' ? undefined : event.target.valueAsNumber)
            }
          />
        ) : (
          <Input
            {...common}
            type="text"
            minLength={field.minLength}
            maxLength={field.maxLength}
            pattern={field.pattern}
            value={typeof value === 'string' ? value : ''}
            onChange={(event) => onChange(name, event.target.value)}
          />
        )}
        {field.description ? (
          <p id={descriptionId} className="text-muted-foreground text-sm">
            {field.description}
          </p>
        ) : null}
        <FieldErrors id={errorId} errors={errors[name] ?? []} />
      </div>
    )
  })
}
