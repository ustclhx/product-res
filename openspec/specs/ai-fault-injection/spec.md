# ai-fault-injection Specification

## Purpose

定义仅供 staging 验收使用的 AI 故障模型如何配置、授权并包装真实服务商链路，使媒体和文本故障可重复触发，同时保持正常用户的模型选择、计费与运行行为稳定。

## Requirements

### Requirement: 故障注入环境闸门
系统 SHALL 仅在显式 staging 环境且 `AI_FAULT_INJECTION=enabled` 时接受故障模型调用；production、未知环境或非法开关值 MUST 校验失败。开关关闭时，正常模型行为 MUST 保持不变，故障模型 MUST 不可调用。

#### Scenario: production 误开
- **WHEN** production 的 web 或 jobs 配置故障注入开关
- **THEN** 环境校验拒绝该配置，不执行故障或服务商调用，错误不含密钥值

#### Scenario: 开关关闭
- **WHEN** 故障模型仍启用但运行时开关缺失或关闭
- **THEN** 故障模型不出现在可用列表，直接调用在创建任务、消息或预扣前被拒绝，正常模型沿用原有行为

#### Scenario: 未明确标记 staging
- **WHEN** 未明确标记 staging 的环境配置 enabled，或开关值非法
- **THEN** web 与 jobs 均拒绝该配置

### Requirement: 故障模型只对平台管理员开放
系统 SHALL 只向已认证的平台管理员展示与开放故障模型；普通成员、空间管理员与 API key 调用 MUST 不可见且不可选。所有调用入口 MUST 在预扣前重新核验权限，不能仅依赖列表或套餐权益。

#### Scenario: 普通用户猜测模型标识
- **WHEN** 普通用户以故障模型 key 或 ID 调用站内媒体、文本或公开 API
- **THEN** 请求被拒绝，不创建任务、消息或预扣，不调用服务商

#### Scenario: 列表缓存跨身份复用
- **WHEN** 管理员读取过故障模型后，普通用户读取模型列表
- **THEN** 普通用户列表不包含任何故障模型

#### Scenario: 管理员合法调用
- **WHEN** staging 开关开启，平台管理员选择启用且具备现有套餐权益的故障模型
- **THEN** 系统使用该模型配置的唯一故障模式并沿用原有额度、限流与计费检查

### Requirement: 故障来源与任务快照
故障模式 SHALL 来自后台模型配置且与 provider、模型种类和专用 key 一致，MUST 拒绝未知或不匹配的配置。调用方 MUST 不能通过业务参数指定或覆盖故障模式或 deadline。已接受媒体任务 SHALL 固定其模式和截止时间；停用模型不改变该任务的结算语义。

#### Scenario: 无效或伪造配置
- **WHEN** 模型配置包含未知故障模式、使用不匹配 provider，或请求参数携带故障控制字段
- **THEN** 配置保存或请求被拒绝，不调用服务商

#### Scenario: 提交后修改模型
- **WHEN** 已接受任务后管理员修改或停用模型
- **THEN** 已接受任务使用原故障快照与定价结算，不转成另一个故障模式

### Requirement: fal 真实链路故障
fal 故障任务 SHALL 向固定低成本图片模型至多提交一次真实请求，保留真实 request ID。回调丢失 SHALL 经真实轮询成功；回调早到 SHALL 复用已验签落库的真实回调；提交响应丢失 SHALL 失败全退且不重提；确定失败及硬超时 SHALL 失败全退。注入 MUST 仅作用于该任务。

#### Scenario: 回调丢失后轮询恢复
- **WHEN** 专用任务未向服务商提供回调地址，真实作业成功
- **THEN** 任务通过原作业轮询成功，产出一份、按定价消费一次，证据确认没有回调且发生轮询

#### Scenario: 回调早到
- **WHEN** 真实验签回调在任务进入正常回调检查前落库
- **THEN** 任务复用该回调成功，不重复提交、产出或消费；没有观察到该顺序时不得认证早到场景通过

#### Scenario: 已受理但提交响应丢失
- **WHEN** 服务商已返回真实 request ID，包装层制造不确定提交错误
- **THEN** 任务为 failed、积分全额释放，证据保留原作业 ID，重放不再次提交，也不把该故障恢复成成功

#### Scenario: 确定服务商失败
- **WHEN** 真实提交后专用包装层报告确定失败
- **THEN** 任务 failed、零消费、全额释放，无可见产出，其他任务不受影响

#### Scenario: 硬超时与迟到结果
- **WHEN** 专用包装层持续返回 queued 且任务超过提交时确定的短 deadline
- **THEN** 任务通过既有 deadline 失败路径全退，迟到结果或工作流重放不产生重复结算或可见产出

### Requirement: Workers AI 受控失败与硬超时
Workers AI 故障模型 SHALL 支持无实际推理的确定失败与模拟未完成推理的硬超时。两者 MUST 使用原任务、预扣与失败结算链路，终态 failed、零消费、全额释放；硬超时 MUST 实际到达任务 deadline，不能直接伪造超时终态。

#### Scenario: 推理失败
- **WHEN** 专用 Workers AI 包装层合成不可重试推理错误
- **THEN** AI 绑定未调用，任务失败且 hold 全额释放，没有生成文件

#### Scenario: 推理未完成超过 deadline
- **WHEN** 专用任务保持未完成并到达短 deadline
- **THEN** 任务进入真实截止时间检查并失败退款，迟到执行不能重复结算

### Requirement: 文本流前与流中故障结算
文本故障模型 SHALL 在流开始前或已有真实输出后注入错误，分别支持 token 与 per_call 定价，并保存实际注入位置与上游调用的持久证明。消息 MUST 为 failed；流前无可见正文时 token 与 per_call 均全额释放预扣（口径见 ai-text-reasoning），流中已有可见正文时 token 按已产生用量、per_call 按固定费用计费。收费 MUST 不超过预扣，结算 MUST 至多一次。

#### Scenario: 流前错误
- **WHEN** token 或 per_call 故障模型在任何输出之前报错
- **THEN** 不产生 assistant 输出；token 与 per_call 均全额释放预扣、消费为零

#### Scenario: 流中错误
- **WHEN** 服务商已流式产生真实文本，包装层中断上游并注入流错误
- **THEN** 保存可见部分回复且标记 failed；per_call 消费一次固定费用，token 按封顶估算用量结算，无额外补扣或欠费

#### Scenario: 错误处理重入
- **WHEN** 错误回调、流清理或后续结算重复执行
- **THEN** 同一消息只结算一次，余额与账本不重复变化
