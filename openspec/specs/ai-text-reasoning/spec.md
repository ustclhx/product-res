# ai-text-reasoning Specification

## Purpose

定义文本模型 thinking 与 reasoning 的配置、展示和用量口径，以及以可见输出为准的失败判定、自动重试、续写与计费规则，使模板可兼容不同外部模型。

## Requirements

### Requirement: thinking 与 reasoning 配置
系统 SHALL 提供模板配置项：thinking 默认开启或关闭、是否允许用户逐条切换 thinking、是否展示 reasoning 过程。模型 MAY 在 `params_schema['x-text']` 声明可选的 `thinking` 能力覆盖：缺省 SHALL 跟随 Provider adapter；显式 `false` SHALL 表示不支持、不下发控制且不允许用户切换；显式 `true` SHALL 表示支持，但无可控 adapter 时仍 SHALL 忽略 thinking 设置。adapter 可控且模型未显式声明 `false` 时，系统 SHALL 始终按模板默认值或允许的请求值显式下发开/关，不依赖模型声明 `true`，当前仅 DeepSeek adapter 可控。

用户开关 SHALL 仅在模板 `userToggle=true`、adapter 可控且模型未显式声明 `false` 时显示并生效。模板关闭用户切换时携带请求 thinking 字段 MUST 返回 400；模板启用但模型不可控时 SHALL 忽略该字段。后台模型保存 SHALL 保持对 `x-text` 的严格校验，拒绝非法值与未知键。

#### Scenario: 不暴露开关时按配置执行
- **WHEN** 模板关闭用户切换且默认关闭 thinking，用户对 adapter 可控且未显式声明 `thinking=false` 的模型发起不含 thinking 字段的对话
- **THEN** 系统显式关闭 thinking 调用模型

#### Scenario: 不暴露开关时拒绝请求字段
- **WHEN** 模板关闭用户切换，用户请求携带 thinking 字段
- **THEN** 系统返回 400，无论所选模型是否可控

#### Scenario: 空 schema 的 DeepSeek 模型遵循模板关闭
- **WHEN** DeepSeek 模型的 `params_schema` 为 `{}`，模板默认 thinking 为 `off`，请求未携带 thinking 字段
- **THEN** 上游请求体含 `thinking: { type: 'disabled' }`

#### Scenario: 空 schema 的 DeepSeek 模型遵循模板开启
- **WHEN** DeepSeek 模型的 `params_schema` 为 `{}`，模板默认 thinking 为 `on`，请求未携带 thinking 字段
- **THEN** 上游请求体含 `thinking: { type: 'enabled' }`

#### Scenario: 用户逐条开启 thinking
- **WHEN** 模板允许用户切换，用户对 adapter 可控且未显式声明 `thinking=false` 的模型开启 thinking 发送消息
- **THEN** 该条回复以开启 thinking 调用模型

#### Scenario: 显式 false 禁用 thinking 控制
- **WHEN** DeepSeek 模型声明 `x-text.thinking=false`，模板允许用户切换且默认 thinking 为 `on`，请求携带 thinking 字段
- **THEN** 页面不显示该模型的用户开关，系统忽略请求字段且不向上游下发 thinking 控制

#### Scenario: 无 adapter 的模型保持原行为
- **WHEN** Provider 无可控 thinking adapter，模型未声明 thinking 或声明 `x-text.thinking=true`，模板允许用户切换且请求携带 thinking 字段
- **THEN** 页面不显示该模型的用户开关，系统忽略模板与请求的 thinking 设置，保持上游调用原行为

### Requirement: reasoning 展示与隔离
展示 reasoning 开启时，系统 SHALL 单独保存 reasoning 并在界面折叠显示；关闭时 MUST NOT 保存或下发 reasoning。reasoning MUST NOT 进入后续对话上下文，API key 接口 MUST NOT 返回 reasoning。

#### Scenario: 关闭展示
- **WHEN** 展示 reasoning 关闭，模型返回 reasoning 与正文
- **THEN** 用户只看到正文，消息中不保存 reasoning

#### Scenario: 后续上下文
- **WHEN** 上一条回复包含已保存的 reasoning，用户继续对话
- **THEN** 发送给模型的历史只包含正文

### Requirement: 可见输出前的自动重试
在可见正文出现前，服务商瞬时错误（限流、5xx、网络或超时）、空回复以及只有 reasoning 的回复 SHALL 在同一预扣下自动重试，次数有限；用户只为最终一次回复付费。展示 reasoning 时，重试 SHALL 清除已显示的 reasoning 并提示正在重试。

#### Scenario: 首次仅 reasoning 后重试成功
- **WHEN** 第一次调用用尽输出上限仍只有 reasoning，第二次调用产生正文并完成
- **THEN** 回复标记 completed，只按一次回复结算，预扣不重复

### Requirement: 可见输出后的续写
可见正文出现后流中断时，对支持续写的模型，系统 SHALL 以原上下文加已生成正文续写，结果作为同一条回复保存与结算，次数有限；不支持续写或续写最终失败时按失败计费规则结算。

#### Scenario: 中断后续写完成
- **WHEN** 支持续写的模型在生成部分正文后连接中断，续写调用完成
- **THEN** 用户看到同一条回复连续追加，消息 completed，只结算一次

### Requirement: 无可见输出的失败不向用户收费
回复最终没有任何可见正文（仅 reasoning、reasoning 阶段中断、输出前报错）时，系统 SHALL 标记 failed 并全额释放预扣，无论 token 或按次计费；上游成本由 SaaS 承担。已有可见正文后最终失败时，token 计费按已产生用量、按次计费收取固定积分，均不超过预扣。失败全退开关开启时，所有 failed 回复 SHALL 全额释放预扣。用户主动停止的计费不变。

#### Scenario: 仅 reasoning 最终失败
- **WHEN** 按次计费的回复在全部重试后仍只有 reasoning
- **THEN** 回复 failed，预扣全额退回

#### Scenario: 有正文后失败
- **WHEN** 按 token 计费的回复生成 200 个正文 token 后续写最终失败，失败全退开关关闭
- **THEN** 回复 failed，按已产生用量结算并退回余量

#### Scenario: 开启失败全退
- **WHEN** 失败全退开关开启，回复在产生正文后最终失败
- **THEN** 回复 failed，预扣全额退回

### Requirement: reasoning 用量统计
系统 SHALL 在用量、检查点与对账中单独记录 reasoning token，并计入输出用量；reasoning 阶段中断的检查点 SHALL 反映已产生的 reasoning 用量。

#### Scenario: 正常完成记录 reasoning
- **WHEN** 开启 thinking 的回复完成，服务商返回 reasoning token
- **THEN** 消息用量记录 reasoningTokens，输出用量包含 reasoning

### Requirement: failed 回复的正文进入后续上下文
failed 回复中已保存的可见正文 SHALL 进入同一对话后续请求的历史。

#### Scenario: 失败后继续对话
- **WHEN** 上一条回复生成部分正文后 failed，用户发送下一条消息
- **THEN** 发送给模型的历史包含该部分正文
