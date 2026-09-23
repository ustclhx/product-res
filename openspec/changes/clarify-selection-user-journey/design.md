## Context

沿用现有 React/FastAPI、工作区隔离、不可变证据与审批快照、暖纸色业务界面。见 proposal.md。用户已确认设计并要求一次完成开发，规划与 apply 在本次授权内连续执行。

## Goals / Non-Goals

Goals: 日常入口可发现；新建后自然续接；当前阶段资料和负责人清楚；同一事项跨页面一致。
Non-Goals: 改变批准权限、自动采购、自动付费采集、虚构供应报价或真实业务完成。

## Decisions

1. 新增 GET /work-items，只读投影现有项目、候选、标准、证据和任务，不增加第二份任务状态。稳定 id 区分项目确认、候选动作、已有 task。返回 items 与 projects、clock；前端统一共享类型/列表。现有 /workbench 保留兼容，试点观察独立 /observations。
2. WorkItem contract: id, kind, title, project_id, project_name, candidate_id|null, candidate_title|null, owner_id|null, assignment_owner_id|null, state, due_at|null, overdue, reason, action_label, href, task_id|null, field|null. state uses TODO/IN_PROGRESS/BLOCKED/DONE/CANCELLED. 缺少执行人由项目分析负责人协调；标准和决策归决策人。仅生成当前阶段有效的缺口；已有活动证据 task 替代相同字段的派生缺口，逾期只是属性。已录入未核验与缺失资料不同，task 完成仍使用既有受控命令，不能因录入自动 DONE。
3. projects summary: id,name,channel,market,direction,analyst_id,decision_owner_id,current_criteria_id,candidate_count,open_item_count,next_action,href,updated_at。项目总体显示候选/事项统计而非强制单阶段。GET 查询不写业务、不调外部服务。
4. 页面契约：/projects?new=1 打开两步新建；/projects/:id?view=criteria 展示标准，?view=settings 设置，?view=history 历史，?view=tasks 项目事项，?intake=1 展开添加候选。候选兼容 stage=evidence/evaluation/review/research，新增 ?field=...&task_id=... 定位补资料；采购/适配表单以 field 映射打开。/tasks?task_id=... 定位执行任务；task 更新成功刷新共享查询。
5. 工作台默认我的未完成事项，等待他人折叠，进行中项目随后；无项目为创建引导。全部事项提供项目/负责人/状态/逾期筛选，保留新建任务、更新、结论功能。缓存包含工作区与 refreshToken，跨页面命令后失效。
6. 项目两步创建不自动确认标准；继承已确认反馈使用既有后端语义。中文字段标签与可编辑清单取代手输字段逗号，保留高级自定义能力。候选资料入口排在配置前。
7. 候选默认阶段依据当前事项与业务状态，顶端展示当前工作、负责人和直接动作；研究 STOP/HOLD 在评估决策内呈现，兼容旧深链。验证、结果链接仅在业务阶段适用时显示。

## Risks / Trade-offs

- 派生缺口与 task 重叠 → 稳定身份、逐字段去重、后端回归覆盖。
- 当前阶段与正式初筛口径不同 → 复用 sourcing requirement 投影，不能将 OEM 研究参考值当正式采购证据。
- 改排导致功能消失 → 保留历史路由/表单，浏览器回归覆盖反馈、市场、核验和验证。
- 同时修改多个页面 → 后端、项目、候选、工作台/事项按目录互斥分工；主代理集成验证。

## Migration Plan

无数据迁移。先本地检查和隔离浏览器验收，再备份当前 ECS 配置/镜像标记并发布 app、worker、gateway；保留前镜像可回滚，不修改凭据、配额或真实业务数据。
