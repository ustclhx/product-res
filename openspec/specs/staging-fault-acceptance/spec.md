# staging-fault-acceptance Specification

## Purpose

定义 staging 受控故障验收如何使用管理员专用模型完成可重复场景、以只读数据证明任务和积分结果，并保存不含凭据或业务内容的证据，供协调者决定原阶段验收是否满足。

## Requirements

### Requirement: 后台准备与最终停用
套件 SHALL 经已有后台模型编辑器创建或启用专用故障模型，严格核对既有配置且不修改不匹配的资源。套件 MUST 在 finally 中停用本次准备的模型并验证停用结果，不直接写 staging 数据库、不写迁移种子。

#### Scenario: 准备后用例失败
- **WHEN** 已有一个或多个故障模型启用，而准备或场景断言失败
- **THEN** 套件停止新业务提交，在 finally 中逐个尝试停用全部已准备模型；清理失败明确报告并保存资源 ID，不把运行认证为成功

#### Scenario: 同名模型冲突
- **WHEN** 已存在专用 key，但 provider、模式、定价或 schema 与预期不一致
- **THEN** 套件停止且不覆盖冲突配置；仍停用此前由本轮准备的模型

#### Scenario: 进程异常结束后重跑
- **WHEN** 同 run ID 的上次运行未执行 finally
- **THEN** 重跑识别遗留模型和业务资源，完成安全停用或恢复核验，不无条件创建新的收费请求

### Requirement: 故障场景结果矩阵
套件 SHALL 顺序验证 Workers 的两个场景、fal 的五个场景以及 token/per_call 各自的流前和流中错误。每个场景 MUST 验证对应终态、hold 释放或精确消费、账本和可见产出，不得仅凭 UI 错误提示判定通过。

#### Scenario: 媒体失败全退
- **WHEN** Workers 失败/超时，或 fal 响应丢失/确定失败/超时完成
- **THEN** 任务 failed、hold released、消费为零、可用积分恢复且无可见文件，记录 task、hold、ledger 和服务商调用证据

#### Scenario: 媒体恢复成功
- **WHEN** fal 回调丢失或早到场景完成
- **THEN** 任务 succeeded、产出一份、消费一次且数额等于定价快照；证据包含轮询恢复或真实回调先落库的场景证明

#### Scenario: 文本两个计费方式
- **WHEN** token/per_call 各自完成流前与流中错误
- **THEN** 四个场景均为 failed，持久证明确认包装器实际执行注入（上游自然错误或阈值未达到不得通过），逐项核验其差异化收费预期与预扣封顶；流中必须存在真实部分输出

### Requirement: 同快照对账与幂等证明
每个场景 SHALL 在同一只读快照验证 `ledgerTotal = activeRemaining + held - debt`，并验证没有重复业务提交、消费或结算。终态后的延迟观察 SHALL 再核验同一资源账本与状态不变；本地夹具 MUST 补充强制重放与迟到结果验证。

#### Scenario: 全额释放没有 refund 分录
- **WHEN** 失败任务仅释放原预扣，没有额外 refund 账本
- **THEN** 套件以 hold 状态、消费为零与对账确认全退，不要求额外退款分录，不再次从 remaining 扣除 hold

#### Scenario: 晚到与重放
- **WHEN** 终态后迟到回调、结果或工作流重放发生
- **THEN** 已结算 hold、消费账本、通知及可见文件不重复，终态不变

### Requirement: 安全证据与真实链路标识
证据 SHALL 包含 run ID、目标、部署版本、故障模式、注入标识、Provider 是否真实调用、业务 ID、hold ID、终态、消费/释放数额、ledger ID 和只读对账结果；媒体 SHALL 记录最小 request ID 与时间顺序证明。证据 MUST 不含凭据、邮箱、提示词、输出正文、回调原文、签名 URL 或连接串。本地夹具证据 MUST 留在已忽略目录，不能作为真实 staging 证据提交。

#### Scenario: 合成 Workers 故障
- **WHEN** 无模型调用的 Workers 故障通过
- **THEN** 证据标记 injected 且 realProviderCalled=false，不能声称真实模型报错

#### Scenario: 真实 fal 或文本流中故障
- **WHEN** 包装了真实 fal 请求或真实文本流
- **THEN** 证据标记 injected 且 realProviderCalled=true，保留可核对 ID 和最小用量，删除所有业务内容与凭据

### Requirement: 重跑保护与运行边界
套件 SHALL 使用稳定 run ID 与场景标识复用已有业务资源；不确定提交、缺失场景证据、重复资源或未确认外部取消 MUST 停止并要求核验，不能盲目重发。故障套件 MUST 独立于默认 e2e、staging smoke 与常规验收，单 worker、无自动重试、人工值守。

#### Scenario: 已有提交结果不明确
- **WHEN** 同 run ID 发现已有任务或消息但终态、提交证据不完整
- **THEN** 套件保留 ID、报告未完成并清理模型，不新增收费任务或发送第二条消息

#### Scenario: 合并发布后执行
- **WHEN** 协调者确认 main 自动发布完成且 health 版本匹配后启动故障套件
- **THEN** 套件先核验目标、版本、管理员、权益与资源准备条件；缺失条件明确未完成，不算成功；仅使用低成本图片 fal 模型，不发送邮件或发起支付

### Requirement: 原验收与本 change 分离
实现完成或故障套件通过 MUST 不自动勾选媒体 7.1/7.2 与 chat 5.1。Gateway token 差异核验、fal 视频成功产出和其他常规验收 SHALL 保持独立，由协调者收齐全部证据后处理。

#### Scenario: 故障套件通过但常规缺口仍存在
- **WHEN** 故障场景全部通过，但 Gateway 比对或 fal 视频成功产出未完成
- **THEN** 原验收项仍未勾选，报告明确列出缺口
