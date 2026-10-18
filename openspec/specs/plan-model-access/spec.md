# plan-model-access Specification

## Purpose

允许平台管理员在计费后台维护套餐的 AI 模型授权，控制普通用户后续调用的准入，并在维护历史模型、其他套餐权益以及重复执行初始化 seed 时保护现有授权数据。

## Requirements

### Requirement: 套餐模型权限编辑
系统 SHALL 在 /admin/billing 下提供套餐列表，仅允许编辑 features.models。编辑器 SHALL 支持现有 ai_model key 与 '*' 多选，并保留不存在的既有 key、显示警告及允许主动移除。更新 MUST 保留其他 features 字段和套餐价格。

#### Scenario: 编辑授权
- **WHEN** 管理员选择一个模型并移除另一个模型后保存
- **THEN** 下一次权益检查允许新增模型，拒绝被移除模型并返回 403，其他权益不变

#### Scenario: 历史模型 key
- **WHEN** 套餐已有的授权 key 不存在于模型列表
- **THEN** 编辑器显示警告并保留该 key，除非管理员主动移除

### Requirement: 实时管理员鉴权与审计
套餐权限写入 MUST 校验数据库中的当前有效管理员会话并写入审计，记录模型列表 before 与 after；普通用户 MUST 无法修改。

#### Scenario: 管理员保存
- **WHEN** 有效管理员保存套餐模型权限
- **THEN** 权限更新及 admin.plan.models.update 审计一同成功，审计含前后列表

#### Scenario: 普通用户写入
- **WHEN** 普通用户请求修改套餐模型权限
- **THEN** 请求被拒绝且数据不变，不产生成功审计

### Requirement: Seed 保留授权与首次运行指引
billing seed 重跑 MUST 保留既有套餐的 models（包括空列表），首次创建 free 的默认 models MUST 仍为 []。首次运行文档 SHALL 指导配置名单、验证并登录、后台创建模型、后台为套餐授权。

#### Scenario: Seed 重跑
- **WHEN** 管理员修改 models 后重跑 billing:seed
- **THEN** 既有 models 保留，新库 free 默认仍为空列表
