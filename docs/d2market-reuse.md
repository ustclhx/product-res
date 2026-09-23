# d2market 复用评估

评估日期：2026-09-20。源目录：`/Users/lihaixin03/workspace/tool/d2market`。
参考 HEAD：`13ce666b187048efc5a0e0a9a57595de77be6c30`。实际迁移以当时工作目录中的选定文件为准，不能把 HEAD 当作所有文件内容的证明；迁移文件另附 SHA-256 清单。

## 结论

复用工程基础和可独立运行的纯规则，保留证据及版本管理的设计。重新实现选品业务，不把监控平台整体搬入。源目录不作修改，原仓库的研究资料与 OpenSpec 工具保留。

| 源内容 | 处理 | 理由 |
| --- | --- | --- |
| `web/package.json`、锁文件、Vite/TS/ESLint 配置 | 裁剪/改名后迁移 | 沿用已使用的前端工具链，锁定版本 |
| `web/src/app/AppProviders.tsx` | 适配迁移 | 复用 Query provider，剥离旧产品依赖 |
| `web/src/app/idempotencyKey.ts` | 迁移通用请求键工具 | 为后续业务命令去重提供基础；仅有客户端键不代表服务端已实现幂等 |
| `web/src/styles/tokens.css` | 复用视觉变量 | 保留中文字体、颜色、焦点等基础约定 |
| `app/api/contracts.py` 的 `APIModel` / `UTCModel` | 提取迁移 | 严格校验、显式时区与 UTC 序列化，无需旧分页/业务契约 |
| `app/runtime/state.py` | 迁移纯状态规则 | 技术执行状态独立于业务状态；不引入数据库队列 |
| `app/runtime/errors.py` | 迁移纯错误策略 | 区分暂时错误、权限、配置、数据质量和策略阻断 |
| `pyproject.toml` 的测试/静态检查设置 | 裁剪迁移，重建锁文件 | 移除 PostgreSQL、浏览器、旧采集系统等依赖 |
| 固定流程、节点 AI、人审、版本快照 | 设计复用 | 适合业务用户；新建选品领域契约 |
| 旧页面、Monitor/QueryPlan/Opportunity 模型、迁移记录 | 不迁移 | 对象和流程与选品项目不同 |
| 连接器、真实 LLM、队列、调度、生产认证/部署 | 本轮不迁移 | 超出示例业务原型范围，依赖大且需要真实运行条件 |
| 密钥、真实环境配置、运行产物、缓存、用户数据 | 不读取、不迁移 | 不属于代码骨架 |

## 可复用的流程与需要改造的部分

| d2market 流程/代码证据 | 在本产品中的用途 | 改造点 |
| --- | --- | --- |
| `app/runtime/state.py:179` `plan_run_transition` | 确定性迁移、非法迁移拒绝、理由记录 | 只描述技术执行；商品业务状态另设 |
| `app/runtime/errors.py:148` `decide_error_policy` | 节点失败后重试、等待、隔离的可解释处理 | 原型以确定性故障样例演示，不开启生产调度 |
| `app/agents/adapter.py:113` `AgentNodePolicy` | 节点 AI 的输入、工具和输出边界 | 原实现依赖旧 signals/budgets；新建模拟 provider 接口 |
| `app/evidence/models.py:50` `EvidenceItem` | 来源定位、反证、推断和建议分离 | 新增商品字段口径、有效期、事实/估算/假设和样例标记 |
| `app/opportunities/decisions.py:85` `DecisionStateEvent` | 追加决策记录，不改写旧评估 | 新状态为批准验证、退回补证、观察、否决；关联提交版本 |
| `app/opportunities/handoffs.py:251` `HandoffPackage` | 下游消费冻结快照 | 新下游是验证任务和结果复盘，不停在导出研究报告 |

## 与已有调研的关系

[市场调研](../research/cross-border-product-selection-ai-agents-2026-09-16.md) 区分了“有数据”“能执行”和“结果改变下轮选择”。本产品采用可追溯的候选—决策—验证—结果—新标准链条；首版演示该结构，不以示例数据证明真实效果，不假设已获任何厂商数据授权。

## 移植验收

必须能脱离源目录安装和运行；健康接口、前端构建/检查、严格契约和通用状态规则测试通过。完整选品业务属于后续 OpenSpec 任务。SHA-256 清单验证被选择的源文件与目标文件，不涉及源凭证、数据或全部仓库快照。
