# Projects / candidates UI

页面入口由 `ProjectsPage`（`/projects`）和 `ProjectPage`（`/projects/:id`）提供，候选详情链接统一使用 `/candidates/:id`。

项目列表读取 `GET /projects` 与 `GET /project-templates`，创建项目使用 `POST /projects`。项目详情读取 `GET /projects/{id}`，标准确认使用 `POST /projects/{id}/criteria-revisions`，携带模板 id/version、完整规则、required_evidence、parent_revision_id 与 expected_version；页面根据当前演示角色显示“需要决策负责人确认”的状态。三种渠道共用固定阶段，渠道字段只影响项目语义和材料提示。

候选入口位于 `candidates/IntakePanel.tsx`：按方向发现调用 `POST /projects/{id}/discovery`，选中后调用 `/discovery/candidates`；手工输入使用 `POST /projects/{id}/candidates`；CSV 使用 `/candidate-imports/preview` 与 `/candidate-imports/confirm`。CSV 必须先预览，展示有效、无效、重复行，再由用户确认提交；文件大小限制和格式错误会在界面显式提示。

页面只消费 `app/client.ts` 的 `api`、`preview`、`command` 与 `useWorkspace`，不在前端生成或静默写入样例数据。
