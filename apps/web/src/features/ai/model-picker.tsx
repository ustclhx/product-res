import { cn, Label, Select, SelectContent, SelectItem, SelectTrigger } from '@product-res/ui'
import { useId } from 'react'
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
  disabled = false,
  compact = false,
}: {
  models: readonly PickerModel[]
  value: string | undefined
  onChange: (id: string) => void
  disabled?: boolean
  /** 对话输入区的左下角：标签只给读屏，触发器为无边框的小按钮（设计稿 chat-components/Main.dc.html） */
  compact?: boolean
}) {
  const id = useId()
  if (models.length === 0)
    return (
      <p role="status" className={cn(compact && 'px-2 text-caption text-muted-foreground')}>
        {MODEL_PICKER_COPY.empty}
      </p>
    )
  const current = models.find((model) => model.id === (value ?? models[0]?.id))
  if (compact)
    return (
      <div className="min-w-0" data-model-picker="">
        <Label htmlFor={id} className="sr-only">
          {MODEL_PICKER_COPY.label}
        </Label>
        <Select
          name="model"
          size="compact"
          value={current?.id ?? ''}
          disabled={disabled}
          onValueChange={onChange}
        >
          <SelectTrigger
            id={id}
            variant="borderless"
            className="min-w-0 max-w-48 px-2 font-medium text-caption"
            placeholder={MODEL_PICKER_COPY.label}
            valueLabel={current?.key}
          />
          <SelectContent>
            {models.map((model, index) => (
              <SelectItem key={model.id} index={index} value={model.id}>
                {model.key}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    )
  return (
    <div data-model-picker="">
      <Label htmlFor={id}>{MODEL_PICKER_COPY.label}</Label>
      <Select name="model" value={current?.id ?? ''} disabled={disabled} onValueChange={onChange}>
        <SelectTrigger
          id={id}
          className="w-full"
          placeholder={MODEL_PICKER_COPY.label}
          valueLabel={current?.key}
        />
        <SelectContent>
          {models.map((model, index) => (
            <SelectItem key={model.id} index={index} value={model.id}>
              {model.key}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
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
