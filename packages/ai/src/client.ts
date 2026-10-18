// 浏览器可用的入口：只含纯函数与类型，不引入数据库与模型实例（入口 `.` 会经 models.ts 引入 @product-res/db）。
// 用于前端的预计消耗显示与输入估算；与服务端共用同一份计算，避免口径不一致。

export {
  createMediaParamsValidator,
  type MediaParams,
  type MediaProperty,
  type MediaSchema,
  parseMediaSchema,
} from './media/params.ts'
export {
  type CreditsEstimateInput,
  DEFAULT_MIN_CHARGE,
  estimateCredits,
  type Pricing,
} from './pricing.ts'
export {
  DEFAULT_MAX_OUTPUT_TOKENS,
  DEFAULT_TOKENS_PER_CHAR,
  estimateInputTokens,
  estimateTextTokens,
  textModelConfigSchema,
} from './text/budget.ts'
