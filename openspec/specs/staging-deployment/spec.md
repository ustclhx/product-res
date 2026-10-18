# staging-deployment Specification

## Purpose

定义 staging 环境如何从 main 分支自动迁移、部署与验证，使各 change 的 staging 验收运行在一个不依赖开发者本机、版本可确认的云端环境上。

## Requirements

### Requirement: main 合并后自动部署 staging
main 分支的 CI 检查全部通过后，系统 SHALL 自动按「数据库迁移 → 部署 jobs → 部署 web」的顺序更新 staging；任一步失败 MUST 停止后续步骤并使流水线失败。

#### Scenario: 正常发布
- **WHEN** 一个提交合并到 main 且 CI 检查通过
- **THEN** staging 数据库应用该提交包含的全部迁移，随后 jobs-staging、web-staging 依次部署该提交

#### Scenario: 迁移失败
- **WHEN** staging 迁移执行失败
- **THEN** jobs 与 web 均不部署，流水线标记失败，staging 继续运行上一版本

#### Scenario: CI 未通过
- **WHEN** main 上某个提交的 CI 检查失败
- **THEN** 不执行 staging 迁移与部署

### Requirement: 同一时间只有一次 staging 发布
staging 发布 MUST 串行执行：新的发布排队等待进行中的发布结束，进行中的发布 MUST NOT 被取消。

#### Scenario: 连续两次合并
- **WHEN** 第一次发布仍在迁移或部署时，第二个提交合并到 main
- **THEN** 第一次发布完整结束后，第二次发布才开始

### Requirement: 部署后确认版本与可用性
web 部署后，流水线 SHALL 轮询 `GET /api/health`，直到返回 200、`db.status` 为 `up` 且 `version` 等于本次提交标识；在限定时间内未满足 MUST 使流水线失败。

#### Scenario: 新版本生效
- **WHEN** web-staging 部署完成且数据库可达
- **THEN** 健康检查在限定时间内返回本次提交标识，流水线进入冒烟测试

#### Scenario: 数据库不可达
- **WHEN** 部署完成但健康检查持续返回 503
- **THEN** 流水线在限定时间后失败，日志中不包含连接串或密钥

### Requirement: staging 冒烟测试
版本确认后，流水线 SHALL 对 staging 运行一组浏览器冒烟测试，至少覆盖首页渲染、定价页渲染、邮箱注册并进入个人空间；任一用例失败 MUST 使流水线失败。

#### Scenario: 主流程可用
- **WHEN** 冒烟测试以新的随机邮箱在 staging 注册
- **THEN** 注册成功并进入该用户的个人空间页面

### Requirement: PR 不改动 staging 数据库
来自 pull request 的流水线 MUST NOT 对 staging 数据库执行迁移或写入，也 MUST NOT 获得 staging 数据库的迁移凭据。

#### Scenario: PR 含新迁移
- **WHEN** 一个包含新迁移的 PR 运行 CI
- **THEN** CI 只在其临时数据库上应用迁移，staging 数据库的迁移记录不变
