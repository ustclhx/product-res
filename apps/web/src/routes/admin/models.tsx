import {
  Button,
  DataTable,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  Textarea,
} from '@product-res/ui'
import { createFileRoute, useRouter } from '@tanstack/react-router'
import { useEffect, useId, useState } from 'react'
import {
  adminListPage,
  adminListSearch,
  filtersToSearch,
  offsetOfPage,
} from '../../features/admin/list.ts'
import { AdminPage, adminTableLabels } from '../../features/admin/ui.tsx'
import {
  CHARGE_ON_VALUES,
  DEFAULT_CHARGE_ON,
  PARAMS_SCHEMA_TEMPLATES,
  PRICING_UNITS,
  parseAdminParamsSchema,
} from '../../features/ai/admin-model-params.ts'
import {
  copyAdminModel,
  getAdminModels,
  saveAdminModel,
  setAdminModelEnabled,
} from '../../features/ai/admin-models.functions.ts'
import { m } from '../../paraglide/messages.js'

export const Route = createFileRoute('/admin/models')({
  validateSearch: (search: Record<string, unknown>) => adminListSearch(['kind', 'order'])(search),
  loaderDeps: ({ search }) => search,
  loader: ({ deps }) => getAdminModels({ data: deps }),
  errorComponent: () => <p role="alert">{m.admin_model_data_is_unavailable_please_reload()}</p>,
  component: Models,
})

type Data = Awaited<ReturnType<typeof getAdminModels>>
type ModelRow = Data['models'][number]
type Kind = ModelRow['kind']
type Mode = 'per_call' | 'token' | 'per_unit'

const ERRORS: Record<string, string> = {
  get MISSING_TOKEN_LIMITS() {
    return m.admin_per_call_text_models_require_input_and_output()
  },
  get INVALID_PRICING() {
    return m.admin_pricing_is_invalid_check_the_required_fields_for()
  },
  get MEDIA_PROVIDER_DISABLED() {
    return m.admin_choose_an_enabled_media_provider()
  },
  get MODEL_PROVIDER_UNAVAILABLE() {
    return m.admin_workers_ai_is_unavailable_on_this_runtime_choose()
  },
  get MODEL_KEY_TAKEN() {
    return m.admin_another_model_already_uses_this_key()
  },
}

/** 表单状态：数值字段保留输入的字符串，提交时再转换 */
interface Draft {
  key: string
  kind: Kind
  provider: string
  providerModelId: string
  paramsSchema: string
  tags: string
  sort: string
  enabled: boolean
  mode: Mode
  credits: string
  chargeOn: string
  maxInputTokens: string
  maxOutputTokens: string
  inputPer1k: string
  outputPer1k: string
  minCharge: string
  unit: string
  perUnit: string
  multipliers: string
}

const str = (value: unknown) => (value === undefined || value === null ? '' : String(value))

function pricingDraft(pricing: Record<string, unknown>) {
  const limits = (pricing.limits ?? {}) as Record<string, unknown>
  return {
    mode: pricing.mode as Mode,
    credits: str(pricing.credits),
    chargeOn: str(pricing.chargeOn),
    maxInputTokens: str(limits.maxInputTokens),
    maxOutputTokens: str(limits.maxOutputTokens),
    inputPer1k: str(pricing.inputPer1k),
    outputPer1k: str(pricing.outputPer1k),
    minCharge: str(pricing.minCharge),
    unit: str(pricing.unit) || 'image',
    perUnit: str(pricing.perUnit),
    multipliers: pricing.multipliers ? JSON.stringify(pricing.multipliers) : '',
  }
}

function toDraft(model: ModelRow): Draft {
  return {
    key: model.key,
    kind: model.kind,
    provider: model.provider,
    providerModelId: model.providerModelId,
    paramsSchema: JSON.stringify(model.paramsSchema ?? {}, null, 2),
    tags: model.tags.join(', '),
    sort: String(model.sort),
    enabled: model.enabled,
    ...pricingDraft(model.pricing),
  }
}

function newDraft(defaults: Data['defaults'], kind: Kind = 'text'): Draft {
  return {
    key: '',
    kind,
    provider: '',
    providerModelId: '',
    paramsSchema: '{}',
    tags: '',
    sort: '0',
    enabled: true,
    ...pricingDraft(defaults[kind] as Record<string, unknown>),
  }
}

/** 空字符串省略该字段，交给服务端校验；非数字原样传 NaN 也会被拒绝 */
const num = (value: string) => (value.trim() === '' ? undefined : Number(value))

function pricingOf(draft: Draft): unknown {
  const multipliers = draft.multipliers.trim() ? JSON.parse(draft.multipliers) : undefined
  switch (draft.mode) {
    case 'per_call': {
      const maxInputTokens = num(draft.maxInputTokens)
      const maxOutputTokens = num(draft.maxOutputTokens)
      return {
        mode: 'per_call',
        credits: num(draft.credits),
        ...(draft.chargeOn ? { chargeOn: draft.chargeOn } : {}),
        ...(multipliers ? { multipliers } : {}),
        ...(maxInputTokens !== undefined || maxOutputTokens !== undefined
          ? { limits: { maxInputTokens, maxOutputTokens } }
          : {}),
      }
    }
    case 'token':
      return {
        mode: 'token',
        inputPer1k: num(draft.inputPer1k),
        outputPer1k: num(draft.outputPer1k),
        minCharge: num(draft.minCharge),
      }
    case 'per_unit':
      return {
        mode: 'per_unit',
        unit: draft.unit,
        perUnit: num(draft.perUnit),
        ...(multipliers ? { multipliers } : {}),
      }
  }
}

function ParamsSchemaEditor({
  label,
  kind,
  provider,
  mediaProviders,
  value,
  disabled,
  onChange,
  onTemplate,
}: {
  label: string
  kind: Kind
  provider: string
  mediaProviders: readonly string[]
  value: string
  /** 外层 fieldset 的禁用态：它不会进入 Radix Select 的状态，需显式传入，避免禁用期间仍能打开 */
  disabled: boolean
  onChange: (value: string) => void
  onTemplate: (message: string) => void
}) {
  const id = useId()
  const templates = PARAMS_SCHEMA_TEMPLATES.filter(
    (template) =>
      template.kind === kind &&
      (kind === 'text' ||
        (template.provider === provider && mediaProviders.includes(template.provider))),
  )
  return (
    <>
      <label className="grid gap-2 text-sm font-medium" htmlFor={`${id}-schema`}>
        {label}
      </label>
      <Textarea
        id={`${id}-schema`}
        className="font-mono"
        rows={12}
        spellCheck={false}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
      <label className="grid gap-2 text-sm font-medium" htmlFor={`${id}-template`}>
        {m.admin_insert_reference_template()}
      </label>
      {/* 动作型选择：值固定为 ''，选中后执行插入，触发器回到占位文字 */}
      <Select
        value=""
        disabled={disabled || templates.length === 0}
        onValueChange={(templateId) => {
          const template = templates.find((item) => item.id === templateId)
          if (!template) return
          onChange(JSON.stringify(template.schema, null, 2))
          onTemplate(
            template.kind !== 'text'
              ? m.admin_reference_inserted_for_verify_the_provider_model_id({
                  modelId: template.providerModelId,
                })
              : m.admin_text_defaults_inserted(),
          )
        }}
      >
        <SelectTrigger
          id={`${id}-template`}
          className="w-full"
          placeholder={m.admin_choose_a_reference_template()}
        />
        <SelectContent>
          {templates.map((template, index) => (
            <SelectItem key={template.id} index={index} value={template.id}>
              {template.id === 'text-defaults' ? m.admin_text_schema_defaults() : template.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <p className="text-muted-foreground text-sm">
        {m.admin_templates_replace_the_schema_check_the_parameters_against()}
      </p>
    </>
  )
}

function Models() {
  const data = Route.useLoaderData()
  const { models, defaults, mediaProviders } = data
  const search = Route.useSearch()
  const navigate = Route.useNavigate()
  // 新建表单很长，默认收起；按钮在水合前禁用，避免 SSR 阶段点击无效
  const [creating, setCreating] = useState(false)
  const [ready, setReady] = useState(false)
  useEffect(() => setReady(true), [])
  return (
    <AdminPage
      title={m.admin_ai_models()}
      description={m.admin_disabled_models_are_hidden_from_model_pickers_and()}
      actions={
        <Button
          type="button"
          variant={creating ? 'outline' : 'default'}
          aria-expanded={creating}
          disabled={!ready}
          onClick={() => setCreating((open) => !open)}
        >
          {m.admin_new_model()}
        </Button>
      }
    >
      <DataTable
        labels={adminTableLabels()}
        label={m.admin_ai_models()}
        rows={models}
        getRowId={(row) => row.id}
        columns={[
          {
            id: 'key',
            header: m.admin_key(),
            cell: (row) => (
              <a href={`#model-${row.id}`} className="underline">
                {row.key}
              </a>
            ),
          },
          { id: 'kind', header: m.admin_type(), cell: (row) => row.kind },
          { id: 'provider', header: m.admin_provider(), cell: (row) => row.provider },
          { id: 'pricing', header: m.admin_pricing(), cell: (row) => String(row.pricing.mode) },
          { id: 'sort', header: m.admin_sort(), cell: (row) => row.sort },
          {
            id: 'enabled',
            header: m.admin_status(),
            cell: (row) => (row.enabled ? m.admin_enabled() : m.admin_disabled()),
          },
        ]}
        page={adminListPage(search.offset, data)}
        filters={[
          {
            id: 'kind',
            label: m.admin_model_type(),
            type: 'select',
            options: [
              { value: 'text', label: m.admin_text() },
              { value: 'image', label: m.admin_image() },
              { value: 'video', label: m.admin_video() },
            ],
          },
          {
            id: 'order',
            label: m.admin_order_models(),
            type: 'select',
            options: [
              { value: 'sort', label: m.admin_sort_ascending() },
              { value: 'sort_desc', label: m.admin_sort_descending() },
              { value: 'key', label: m.admin_key_ascending() },
              { value: 'key_desc', label: m.admin_key_descending() },
            ],
          },
        ]}
        filterValues={{ kind: search.kind, order: search.order }}
        onPageChange={(page) =>
          void navigate({ search: { ...search, offset: offsetOfPage(page) } })
        }
        onFiltersChange={(values) =>
          void navigate({ search: filtersToSearch(['kind', 'order'], values) })
        }
      />
      {creating && (
        <ModelEditor
          key="new"
          initial={newDraft(defaults)}
          defaults={defaults}
          mediaProviders={mediaProviders}
        />
      )}
      {models.map((model) => (
        <ModelEditor
          key={model.id}
          model={model}
          initial={toDraft(model)}
          defaults={defaults}
          mediaProviders={mediaProviders}
        />
      ))}
    </AdminPage>
  )
}

function ModelEditor({
  model,
  initial,
  defaults,
  mediaProviders,
}: {
  model?: ModelRow
  initial: Draft
  defaults: Data['defaults']
  mediaProviders: Data['mediaProviders']
}) {
  const router = useRouter()
  const [draft, setDraft] = useState(initial)
  const [busy, setBusy] = useState(false)
  const [ready, setReady] = useState(false)
  const [message, setMessage] = useState('')
  const [copyKey, setCopyKey] = useState(model ? `${model.key.slice(0, 59)}-copy` : '')
  const savedParamsSchema = JSON.stringify(model?.paramsSchema ?? {}, null, 2)
  const [copyParamsSchema, setCopyParamsSchema] = useState(savedParamsSchema)
  // SSR 表单先禁用，避免 React 接管前的输入丢失或保存点击无效。
  useEffect(() => setReady(true), [])
  useEffect(() => {
    setCopyParamsSchema(savedParamsSchema)
  }, [savedParamsSchema])
  const set = (patch: Partial<Draft>) => setDraft((current) => ({ ...current, ...patch }))
  const field = (name: keyof Draft) => ({
    id: `${model?.id ?? 'new'}-${name}`,
    value: String(draft[name]),
    onChange: (event: { target: { value: string } }) => set({ [name]: event.target.value }),
  })

  async function act(
    action: () => Promise<{ ok: true } | { ok: false; error: string; message?: string }>,
  ) {
    setBusy(true)
    try {
      const result = await action()
      if (result.ok) {
        setMessage(m.admin_saved())
        if (!model) setDraft(newDraft(defaults))
        await router.invalidate()
      } else {
        setMessage(
          result.message ?? ERRORS[result.error] ?? m.admin_save_rejected({ error: result.error }),
        )
      }
    } catch {
      setMessage(m.admin_save_unavailable_check_the_fields_multipliers_must_be())
    } finally {
      setBusy(false)
    }
  }

  function validateParamsSchema(kind: Kind, json: string) {
    try {
      parseAdminParamsSchema(kind, json)
      return true
    } catch (error) {
      setMessage(error instanceof Error ? error.message : m.admin_parameter_schema_is_invalid())
      return false
    }
  }

  function save() {
    if (!validateParamsSchema(draft.kind, draft.paramsSchema)) return
    return act(() =>
      saveAdminModel({
        data: {
          ...(model ? { id: model.id } : {}),
          key: draft.key,
          kind: draft.kind,
          provider: draft.provider,
          providerModelId: draft.providerModelId,
          paramsSchema: draft.paramsSchema,
          pricing: pricingOf(draft),
          tags: draft.tags.split(','),
          enabled: draft.enabled,
          sort: Number(draft.sort) || 0,
        },
      }),
    )
  }

  function copy() {
    if (!model || !validateParamsSchema(model.kind, copyParamsSchema)) return
    return act(() =>
      copyAdminModel({ data: { id: model.id, key: copyKey, paramsSchema: copyParamsSchema } }),
    )
  }

  const title = model ? m.admin_model_title({ key: model.key }) : m.admin_new_model()
  const disabled = busy || !ready
  return (
    <article
      aria-label={title}
      aria-busy={disabled}
      id={model ? `model-${model.id}` : 'new-model-editor'}
      className="grid min-w-0 gap-5 rounded-lg border bg-card p-5 text-card-foreground"
    >
      <h3 className="font-semibold text-lg">
        {title}
        {model && !model.enabled && m.admin_disabled_suffix()}
      </h3>
      <fieldset disabled={disabled} className="grid gap-4 sm:grid-cols-2">
        <legend className="mb-3 font-medium">{m.admin_model()}</legend>
        <label className="grid gap-2 text-sm font-medium" htmlFor={`${model?.id ?? 'new'}-key`}>
          {m.admin_key()} <Input required maxLength={64} {...field('key')} />
        </label>
        <div className="grid gap-2">
          <label className="font-medium text-sm" htmlFor={`${model?.id ?? 'new'}-kind`}>
            {m.admin_kind()}
          </label>
          <Select
            value={draft.kind}
            disabled={disabled || Boolean(model)}
            onValueChange={(value) => {
              const kind = value as Kind
              // 新建时切换类型按模板配置重新预填计费方式
              setDraft((current) => ({
                ...current,
                kind,
                provider: kind === 'text' ? '' : (mediaProviders[0] ?? ''),
                ...pricingDraft(defaults[kind] as Record<string, unknown>),
              }))
            }}
          >
            <SelectTrigger
              id={`${model?.id ?? 'new'}-kind`}
              className="w-full"
              placeholder={m.admin_kind()}
            />
            <SelectContent>
              <SelectItem index={0} value="text">
                {m.admin_text()}
              </SelectItem>
              <SelectItem index={1} value="image">
                {m.admin_image()}
              </SelectItem>
              <SelectItem index={2} value="video">
                {m.admin_video()}
              </SelectItem>
            </SelectContent>
          </Select>
        </div>
        {draft.kind === 'text' ? (
          <label
            className="grid gap-2 text-sm font-medium"
            htmlFor={`${model?.id ?? 'new'}-provider`}
          >
            {m.admin_provider()} <Input required maxLength={64} {...field('provider')} />
          </label>
        ) : (
          <div className="grid gap-2">
            <label className="font-medium text-sm" htmlFor={`${model?.id ?? 'new'}-provider`}>
              {m.admin_provider()}
            </label>
            <Select
              required
              disabled={disabled}
              // 值必须在选项里：已停用的服务商显示占位文字，而不是空白触发器
              value={mediaProviders.includes(draft.provider) ? draft.provider : ''}
              onValueChange={(provider) => set({ provider })}
            >
              <SelectTrigger
                id={`${model?.id ?? 'new'}-provider`}
                className="w-full"
                placeholder={m.admin_choose_a_provider()}
              />
              <SelectContent>
                {mediaProviders.map((provider, index) => (
                  <SelectItem key={provider} index={index} value={provider}>
                    {provider}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}
        <label
          className="grid gap-2 text-sm font-medium"
          htmlFor={`${model?.id ?? 'new'}-providerModelId`}
        >
          {m.admin_provider_model_id()}{' '}
          <Input required maxLength={200} {...field('providerModelId')} />
        </label>
        <label className="grid gap-2 text-sm font-medium" htmlFor={`${model?.id ?? 'new'}-tags`}>
          {m.admin_plan_tags_comma_separated()} <Input {...field('tags')} />
        </label>
        <label className="grid gap-2 text-sm font-medium" htmlFor={`${model?.id ?? 'new'}-sort`}>
          {m.admin_sort()} <Input type="number" step="1" {...field('sort')} />
        </label>
        <label className="flex items-center gap-2 text-sm font-medium">
          <input
            className="size-4 accent-primary"
            type="checkbox"
            checked={draft.enabled}
            onChange={(event) => set({ enabled: event.target.checked })}
          />{' '}
          {m.admin_enabled()}
        </label>
      </fieldset>
      <fieldset disabled={disabled} className="grid min-w-0 gap-3">
        <legend className="mb-3 font-medium">{m.admin_parameters()}</legend>
        <ParamsSchemaEditor
          label={m.admin_parameters_schema_json()}
          kind={draft.kind}
          provider={draft.provider}
          mediaProviders={mediaProviders}
          value={draft.paramsSchema}
          disabled={disabled}
          onChange={(paramsSchema) => set({ paramsSchema })}
          onTemplate={setMessage}
        />
      </fieldset>
      <fieldset disabled={disabled} className="grid gap-4 sm:grid-cols-2">
        <legend className="mb-3 font-medium">{m.admin_pricing()}</legend>
        <div className="grid gap-2">
          <label className="font-medium text-sm" htmlFor={`${model?.id ?? 'new'}-mode`}>
            {m.admin_pricing_mode()}
          </label>
          <Select
            disabled={disabled}
            value={draft.mode}
            onValueChange={(mode) => set({ mode: mode as Mode })}
          >
            <SelectTrigger
              id={`${model?.id ?? 'new'}-mode`}
              className="w-full"
              placeholder={m.admin_pricing_mode()}
            />
            <SelectContent>
              <SelectItem index={0} value="per_call">
                {m.admin_per_call()}
              </SelectItem>
              <SelectItem index={1} value="token">
                {m.admin_per_token()}
              </SelectItem>
              <SelectItem index={2} value="per_unit">
                {m.admin_per_unit()}
              </SelectItem>
            </SelectContent>
          </Select>
        </div>
        {draft.mode === 'per_call' && (
          <>
            <label
              className="grid gap-2 text-sm font-medium"
              htmlFor={`${model?.id ?? 'new'}-credits`}
            >
              {m.admin_credits_per_call()}{' '}
              <Input type="number" min="0" step="1" {...field('credits')} />
            </label>
            <div className="grid gap-2">
              <label className="font-medium text-sm" htmlFor={`${model?.id ?? 'new'}-chargeOn`}>
                {m.admin_charge_on()}
              </label>
              <Select
                disabled={disabled}
                // 「默认」用占位值表示；未知的已存值同样落到「默认」显示
                value={
                  CHARGE_ON_VALUES.some((value) => value === draft.chargeOn)
                    ? draft.chargeOn
                    : DEFAULT_CHARGE_ON
                }
                onValueChange={(value) =>
                  set({ chargeOn: value === DEFAULT_CHARGE_ON ? '' : value })
                }
              >
                <SelectTrigger
                  id={`${model?.id ?? 'new'}-chargeOn`}
                  className="w-full"
                  placeholder={m.admin_default()}
                />
                <SelectContent>
                  <SelectItem index={0} value={DEFAULT_CHARGE_ON}>
                    {m.admin_default()}
                  </SelectItem>
                  <SelectItem index={1} value="any_output">
                    {m.admin_any_output()}
                  </SelectItem>
                  <SelectItem index={2} value="success">
                    {m.admin_success()}
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
            <label
              className="grid gap-2 text-sm font-medium"
              htmlFor={`${model?.id ?? 'new'}-maxInputTokens`}
            >
              {m.admin_max_input_tokens()}{' '}
              <Input type="number" min="1" step="1" {...field('maxInputTokens')} />
            </label>
            <label
              className="grid gap-2 text-sm font-medium"
              htmlFor={`${model?.id ?? 'new'}-maxOutputTokens`}
            >
              {m.admin_max_output_tokens()}{' '}
              <Input type="number" min="1" step="1" {...field('maxOutputTokens')} />
            </label>
          </>
        )}
        {draft.mode === 'token' && (
          <>
            <label
              className="grid gap-2 text-sm font-medium"
              htmlFor={`${model?.id ?? 'new'}-inputPer1k`}
            >
              {m.admin_input_credits_1k()}{' '}
              <Input type="number" min="0" step="any" {...field('inputPer1k')} />
            </label>
            <label
              className="grid gap-2 text-sm font-medium"
              htmlFor={`${model?.id ?? 'new'}-outputPer1k`}
            >
              {m.admin_output_credits_1k()}{' '}
              <Input type="number" min="0" step="any" {...field('outputPer1k')} />
            </label>
            <label
              className="grid gap-2 text-sm font-medium"
              htmlFor={`${model?.id ?? 'new'}-minCharge`}
            >
              {m.admin_minimum_charge()}{' '}
              <Input type="number" min="0" step="1" {...field('minCharge')} />
            </label>
          </>
        )}
        {draft.mode === 'per_unit' && (
          <>
            <div className="grid gap-2">
              <label className="font-medium text-sm" htmlFor={`${model?.id ?? 'new'}-unit`}>
                {m.admin_unit()}
              </label>
              <Select
                disabled={disabled}
                value={PRICING_UNITS.some((unit) => unit === draft.unit) ? draft.unit : ''}
                onValueChange={(unit) => set({ unit })}
              >
                <SelectTrigger
                  id={`${model?.id ?? 'new'}-unit`}
                  className="w-full"
                  placeholder={m.admin_unit()}
                />
                <SelectContent>
                  <SelectItem index={0} value="image">
                    {m.admin_image()}
                  </SelectItem>
                  <SelectItem index={1} value="second">
                    {m.admin_second()}
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
            <label
              className="grid gap-2 text-sm font-medium"
              htmlFor={`${model?.id ?? 'new'}-perUnit`}
            >
              {m.admin_credits_per_unit()}{' '}
              <Input type="number" min="0" step="any" {...field('perUnit')} />
            </label>
          </>
        )}
        {draft.mode !== 'token' && (
          <label
            className="grid gap-2 text-sm font-medium"
            htmlFor={`${model?.id ?? 'new'}-multipliers`}
          >
            {m.admin_multipliers_json_optional()}{' '}
            <Input placeholder='{"resolution":{"720p":1,"1080p":2}}' {...field('multipliers')} />
          </label>
        )}
      </fieldset>
      <div className="flex flex-wrap gap-3">
        <Button type="button" disabled={disabled} onClick={save}>
          {model ? m.admin_save_changes() : m.admin_create_model()}
        </Button>
        {model && (
          <Button
            type="button"
            variant="outline"
            disabled={disabled}
            onClick={() =>
              act(() => setAdminModelEnabled({ data: { id: model.id, enabled: !model.enabled } }))
            }
          >
            {model.enabled ? m.admin_disable() : m.admin_enable()}
          </Button>
        )}
      </div>
      {model && (
        <fieldset disabled={disabled} className="grid min-w-0 gap-3 rounded-md border p-4">
          <legend className="px-2 font-medium">{m.admin_copy_saved_model()}</legend>
          <label className="grid gap-2 text-sm font-medium" htmlFor={`${model?.id}-copy-key`}>
            {m.admin_copy_key()}{' '}
            <Input
              id={`${model?.id}-copy-key`}
              value={copyKey}
              maxLength={64}
              onChange={(event) => setCopyKey(event.target.value)}
            />
          </label>
          <ParamsSchemaEditor
            label={m.admin_copy_parameters_schema_json()}
            kind={model.kind}
            provider={model.provider}
            mediaProviders={mediaProviders}
            value={copyParamsSchema}
            disabled={disabled}
            onChange={setCopyParamsSchema}
            onTemplate={setMessage}
          />
          <Button type="button" variant="outline" className="w-fit" onClick={copy}>
            {m.admin_copy_model()}
          </Button>
          <p className="text-muted-foreground text-sm">
            {m.admin_the_copy_is_disabled_until_you_enable_it()}
          </p>
        </fieldset>
      )}
      <p role="status" className="min-h-5 text-sm">
        {ready ? message : m.admin_loading_editor()}
      </p>
    </article>
  )
}
