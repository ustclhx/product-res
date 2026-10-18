import { Label } from '@product-res/ui'
import {
  creditEstimate,
  type EstimateOptions,
  formatEstimate,
  MODEL_PICKER_COPY,
  type PickerModel,
} from './model-picker.ts'

/** 模型下拉框；`models` 已按空间权益与启用状态过滤（`getPickerModels`） */
export function ModelPicker({
  models,
  value,
  onChange,
  disabled,
}: {
  models: readonly PickerModel[]
  value: string | undefined
  onChange: (id: string) => void
  disabled?: boolean
}) {
  if (models.length === 0) return <p role="status">{MODEL_PICKER_COPY.empty}</p>
  return (
    <p>
      <Label htmlFor="ai-model">{MODEL_PICKER_COPY.label}</Label>
      <select
        id="ai-model"
        name="model"
        className="rounded-md border p-2"
        value={value ?? models[0]?.id}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
      >
        {models.map((model) => (
          <option key={model.id} value={model.id}>
            {model.key}
          </option>
        ))}
      </select>
    </p>
  )
}

/** 提交按钮旁的预计消耗 */
export function CreditEstimateText({
  model,
  ...options
}: { model: PickerModel | undefined } & EstimateOptions) {
  if (!model) return null
  return (
    <span data-testid="credit-estimate" className="text-muted-foreground text-sm">
      <span className="sr-only">{MODEL_PICKER_COPY.estimate}: </span>
      {formatEstimate(creditEstimate(model.pricing, options))}
    </span>
  )
}
