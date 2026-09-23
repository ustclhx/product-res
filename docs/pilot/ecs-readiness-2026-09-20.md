# ECS 与 NewAPI 核查及部署记录

用户指定测试主机 root@43.106.17.72，与 d2market 同机。下列“已观察”为规划阶段只读检查；本轮实施结果见文末。规划阶段未修改远端服务。

## 已观察

- Linux，2 vCPU；内存总量约 3495 MiB，采样时 available 约 908 MiB；交换区 2047 MiB，采样时未使用；根盘 59 GiB，可用约 21 GiB。此为时点数据，不是可持续容量保证。
- d2market gateway 已占用 80/443，sub2api 占用 8080，new-api 占用 3000，另有其他常驻服务。不能使用这些端口启动 product-res。
- d2market 使用独立 gateway/api/scheduler/worker/postgres Compose 服务，并有低资源覆盖配置；worker CPU 上限 0.25、内存上限 512 MiB。
- NewAPI `/api/status` 返回 HTTP 200、success=true，报告版本 v1.0.0-rc.22。
- 从现有 worker 容器按已配置 secret 文件引用发起只读 `/v1/models` 请求，HTTP 200；该 token 可见 1 个模型，配置的 `deepseek-v4-flash` 在清单中。只输出上述元数据，未输出凭据、其他环境变量或用户内容。
- d2market 容器入口为 `http://host.docker.internal:3000/v1`，secret 通过 `/run/secrets/newapi_key` 挂载。该地址和模型是现场配置事实，不代表 product-res 已拥有独立凭据或完成推理测试。

## 部署决定

product-res 使用独立 Compose 项目、目录、卷和登录配置，复用 ECS 与 NewAPI 服务，不复用 d2market 业务数据库。应用镜像在本地/CI 构建后上传；先以一个 API 进程、一个低并发 worker、静态 gateway 和每工作区独立 SQLite 文件运行，不额外常驻 Redis/Postgres/浏览器采集。

建议总内存上限起步不超过约 576 MiB（API 256、worker 256、gateway 64），并发外部任务起步为 1；这些是待实际试跑验证的保护配置，非性能承诺。上线前再次检查现有服务健康与资源，容量不足时暂停新增负载。

先在空闲环回端口通过 SSH 隧道验证；合作团队访问前配置独立 HTTPS 入口、登录和 cookie 安全。公网域名/证书及入口尚未提供，不擅自改动 d2market 的 80/443 路由。NewAPI 使用仅服务端可读的 product-res 凭据引用；不沿用模型别名硬编码，也不修改共享网关的全局额度或渠道。

## 规划阶段尚未验证（实施结果见下方）

product-res 镜像启动、worker 长期运行、新 API token 权限、模型 JSON 生成、真实市场账号、网络到市场服务的授权调用、HTTPS 入口和双团队闭环。这些列入实施任务，不能用本次 HTTP 200 的状态检查代替。


## 本轮实施结果（2026-09-20）

- 独立目录 `/opt/product-res-pilot`、Compose 项目 `product-res-pilot`、卷 `product-res-pilot-data` 已部署。
- 三容器：API、worker、gateway。API 健康，worker 正常运行，gateway 仅监听 `127.0.0.1:18081`。
- API/worker 为 UID 10001、gateway 为 UID 101；均为只读 rootfs、移除 capabilities、禁止提权；内存上限分别 256/256/64 MiB。
- 采样 API/worker 合计约 90 MiB，发布后 available 约 947 MiB，swap 未使用；这不是长期性能承诺。
- 前端和 `/api/v1/health` HTTP 200，健康回执为 `mode=pilot`。本机 SSH 隧道也已验证两者可达。
- `partner-team` 与 `internal-dtc` 两个空工作区已创建，各有分析/决策账号；四个账号登录、会话恢复和退出均通过，项目数均为零。
- 初始随机口令只存于 ECS `/opt/product-res-pilot/operator/initial-accounts.json`（私有目录、文件 0600），没有提交到代码或输出到会话。账号交付给具体成员前由操作者私下分发；不当作默认公共口令。
- 发布前后 d2market API/worker/scheduler/gateway 与 NewAPI 均健康；没有重启或修改这些服务。

镜像记录（来自实际运行容器）：

| 服务 | 标签 | 镜像标识 |
| --- | --- | --- |
| API / worker | `product-res-pilot:20260920-v1` | `sha256:9cd2180b2ff7324c01ec9ee8cc5cc8fdc8b9f8a3259388067d48f4a60204bb56` |
| gateway | `product-res-gateway:20260920-v1` | `sha256:1ce8ffd845e02628f6776cad21fcc8251f36b0012c2bf7228fc5ff18bcbdddb8` |

两镜像在本机完成 amd64 构建后上传，ECS 未执行应用构建。默认 SFTP 上传异常缓慢，传统 `scp -O` 完成传输；启动使用 `docker compose -f compose.pilot.yaml up --no-build -d`。

### 备份与恢复

API/worker 启动前的静止点已备份控制库及两工作区库到 `/opt/product-res-pilot/backups/initial-20260920`，恢复到 `/opt/product-res-pilot/backups/restored-20260920`。恢复实例挂载为 `/data` 后，控制注册路径、业务库身份、完整性均通过；原卷未覆盖。当前库无业务任务，非空 Job/输入版本保留由本地恢复回归验证。

### NewAPI 实测与待办

为 product-res 创建了现有服务端凭据的独立文件引用；没有创建独立权限 token，也没有修改共享 NewAPI 渠道或额度。模型清单检查通过，但一次合成探针的结构化生成返回 HTTP 403。没有自动重试，没有写入业务数据，费用/usage 未知；脱敏回执见 [NewAPI smoke](newapi-smoke-2026-09-20.json)。因此已从当前启用配置移除 NewAPI，候选配置保留在服务器私有 operator 目录；等待允许推理的 product-res 凭据。

两个市场来源均缺凭据且未开启授权开关。HTTPS 团队入口未配置；目前仅 SSH 隧道可访问，不能把 ECS 可用表述为已对合作团队开放，更不能计为两条真实业务闭环。

需要重建本机隧道时：

```sh
ssh -N -L 127.0.0.1:18081:127.0.0.1:18081 root@43.106.17.72
```

然后访问 `http://127.0.0.1:18081`。不要为方便访问而把当前 HTTP 端口绑定到公网。

### 本次接入排查后的应用更新

API/worker 已更新为 `product-res-pilot:20260920-v2`，实际容器镜像标识 `sha256:70ccf9ba93d5c69d6520d797158edbb7b7590bbb9678afe57e73cb3a83441673`；gateway 仍为 v1。更新内容为上游模型资格错误的明确分类与安全提示。发布前停止 API/worker，并备份到 `/opt/product-res-pilot/backups/pre-v2-20260920`；没有数据库迁移。发布后 pilot 健康接口通过，既有 d2market/NewAPI 健康。

本次复现的上游码为 `AccessDenied.Unpurchased`。只读路由核验确认渠道启用、无模型重映射、当前令牌有效未过期且内部额度不限。百炼账号资格尚未恢复，模型入口继续关闭。详细材料与启用次序见 [管理员接入清单](credential-handoff.md)。

发布后四个账号的登录、会话恢复、退出与工作区身份再次通过；本机 SSH 隧道健康检查通过。两工作区仍为空，来源状态分别为 DataForSEO/SerpApi `CREDENTIAL_MISSING`、NewAPI `NOT_CONFIGURED`。

### DeepSeek 官方渠道切换与车辆内饰试点

用户确认：模型改用 DeepSeek 官方渠道，车辆内饰为首轮方向，团队先走 SSH 隧道，后续由用户配置现有域名的 Cloudflare 子域名。

发现私有 secret 引用带固定渠道 3 后缀；仅将 `/opt/product-res-pilot/secrets/newapi` 的固定渠道改为 1，私有备份位于 operator 目录。共享令牌、NewAPI 渠道参数及 d2market secret 没有修改。渠道 1 为 DeepSeek 官方类型，模型为 `deepseek-v4-flash`。

默认思考模式在 1500 输出 token 限额下产生截断；改为 `thinking_mode=disabled` 后完整输出，并补强无证据不得生成 FACT 的约束。三个节点合成输入真实 smoke 均通过，耗时约 2.7–2.9 秒，合计 2950 token，费用字段未返回，保持未知。见 [脱敏回执](deepseek-smoke-2026-09-20.json)。

API/worker 已发布 `product-res-pilot:20260920-v3`，实际镜像 `sha256:8833eb6623401756bab5b5320736b55169bca2abd0e1ae6ddee5c39f2ad07643`；gateway 保持 v1。发布前备份到 `/opt/product-res-pilot/backups/pre-v3-20260920`，本次没有数据库迁移。模型配置为每工作区 5 个任务、60 秒、1800 输出/20000 总 token 上限、提示词版本 `newapi-prompt-v2-deepseek-nonthinking`。既有服务保持健康。

两个工作区各建“车辆内饰 · 美国站首轮试点”草稿：partner-team 为 AMAZON，internal-dtc 为 DTC。仅保存用户确认的方向与待确认事项，未确认标准、未造市场证据、未批准候选。市场 API 凭据仍待提供，真实闭环未完成。

发布后四个账号登录、会话恢复与退出通过，各自看到一条车辆内饰草稿；NewAPI 状态均为 READY。只读网关日志也确认本次三个成功探针均命中渠道 1，用量与回执一致。

### 2026-09-21 凭据与研究标准部署

两个市场凭据已由用户提供并安装为 ECS 私有 secret。SerpApi 内部 DTC 研究查询成功；DataForSEO 凭据认证通过，但 Amazon 接口要求账号验证（40104），保持未启用。具体回执见 [真实市场验证](live-market-verification-2026-09-21.md)。

用户确认首轮无商业淘汰阈值；应用新增允许空规则、保留必需证据的研究标准。API/worker 发布 `product-res-pilot:20260921-v4`，镜像 `sha256:ebee6b04f70f9c666f30f5f0edc520cec20746432a426de8773fb6c2e19c2a28`；gateway 发布 `product-res-gateway:20260921-v2`，镜像 `sha256:8b6abb402a3ef68491dcc3de8ce384c173f23abbaeff9d3730c5453a1513442d`。镜像基于此前已验证的 amd64 镜像构建，本次未修改依赖或数据库结构。

发布前停止独立 API/worker，备份到 `/opt/product-res-pilot/backups/pre-research-20260921`。发布后 pilot 健康、d2market/NewAPI 健康；共享服务没有重启。本地凭据目录已从 Git 与 Docker 构建上下文排除。

查询历史交接补充：gateway 后续更新为 `product-res-gateway:20260921-v3`，镜像 `sha256:d506e82ac4b0beebccc7a20fade171dafb1625bacfa93b5823c6a18d346c26da`，仅替换 gateway。新增按工作区/项目读取已有查询任务并打开批次，避免新浏览器重复消费查询；前端默认研究方向来自项目。三项 pilot 浏览器测试通过，额外验证打开历史不发送发现 POST、研究方向正确。API/worker 仍为 v4，健康检查通过。

### 2026-09-21 DataForSEO 查询恢复发布

DataForSEO 账号验证已生效。原 Live 查询在 30 秒超时边界成功，应用按未知结果保留；通过官方 ID List / Task GET 免费核对并取回同一任务，未重复采集。后端新增受限运营恢复函数，以及市场来源 `timeout_seconds`（默认 30、范围 1–120）；合作团队 DataForSEO 配置为 90 秒，请求预算仍为 1，自动外发次数仍为 1。

API/worker 已发布 `product-res-pilot:20260921-v5`，镜像 `sha256:71a595f4dc13e16d7a100f12f8fdb0657c3c10a8698ea22340b6ea720548a728`，与本机构建摘要完全一致。因网络上传慢，仅传输本机镜像新增层，利用 ECS 现有基础层组装 Docker 归档后加载；服务器没有重新构建或安装依赖。gateway 保持 `product-res-gateway:20260921-v3`。发布前停止本项目 API/worker 并备份到 `/opt/product-res-pilot/backups/pre-dfs-recovery-20260921`，无数据库迁移。

发布后 pilot 健康、本机 SSH 隧道健康；d2market、NewAPI 均保持健康。原任务恢复为 SUCCEEDED、保留原 OUTCOME_UNKNOWN attempt 和唯一恢复审计；重复恢复返回 reused=true、批次 ID 不变，共 10 条。原采集费用 0.0033 USD，Task GET 费用独立记录为 0。`make check` 通过（137 项后端测试、Ruff、mypy、前端 lint/build 和 2 项前端单元测试），OpenSpec strict 通过。详细业务状态见 [DataForSEO 验证记录](dataforseo-verification-2026-09-21.md)。
