# selfhost-deployment Specification

## Purpose
定义可选自托管目标在普通 Linux Docker Compose 环境中的构建、启动、入口和容器安全行为，提供本地可验证的基础拓扑，同时保障原 Cloudflare 开发与发布路径。

## Requirements

### Requirement: 可选 Node 服务端目标
web 和 jobs SHALL 提供独立 Node LTS 生产输出与启动入口，支持原生 Node 模块，不添加平台 CPU 时长限制；默认构建仍为 Cloudflare。Node web SHALL 支持 SSR、Server Functions、静态资源、流式响应及数据库不可达时的公开页/预渲染降级。（R1、R5、R6）

#### Scenario: 运行 Node 产物
- **WHEN** 启动 web/jobs 的 Node 生产输出
- **THEN** 服务无需 workerd 运行，web 页面、Server Function 与流式端点可用，jobs 进程报告真实能力状态

#### Scenario: 无数据库构建
- **WHEN** 没有生产凭据且数据库不可达时构建公开页面
- **THEN** 预渲染使用既有降级行为并成功，不读取生产密钥

### Requirement: Compose 顺序启动
官方 SHALL 提供 deploy/selfhost/compose.yaml，含 postgres、缓存、一次性 migrate、web、jobs 和可选代理 profile。Compose SHALL 消费已构建镜像，MUST 不在服务器构建。应用启动 MUST 等待数据库与缓存就绪以及使用 migrator 的迁移成功；迁移支持现有 SQL。（D3）

#### Scenario: 空白环境
- **WHEN** 已填写配置/secret并提供测试或正式镜像引用，在空卷部署目录执行 docker compose up -d
- **THEN** 创建角色与权限、完成迁移后启动应用，不需要服务器编译源码

#### Scenario: 迁移失败
- **WHEN** 一次性迁移容器退出非零
- **THEN** web/jobs 不启动，部署保留失败状态，不通过无限重启迁移掩盖错误

### Requirement: 单一安全 HTTP 入口
自托管 SHALL 只有代理暴露宿主机 80/443，Postgres、缓存、web、jobs MUST 不映射宿主机端口。可选内置代理 SHALL 支持 ACME 与自带证书；配置 profile 后 SHALL 仍可使用普通 docker compose up -d。关闭内置代理时 SHALL 可经外部代理接入。（H1、D5）

#### Scenario: 独立 Compose TLS
- **WHEN** 使用内置代理 profile 与合法域名或自带证书部署
- **THEN** 通过 80/443 访问站点，数据服务只在 Compose 内网可达

#### Scenario: 外部代理
- **WHEN** 关闭内置代理并从专用 ingress 网络接入外部代理
- **THEN** 服务可被代理访问，而数据库/缓存无公网端口

### Requirement: 非 root 与运行边界
全部容器 SHALL 在初始化和正常运行阶段使用非 root 用户，具有健康检查和资源上限。常驻服务 SHALL restart unless-stopped，一次性 migrate SHALL 完成即退出且不自动重启；数据和证书 SHALL 持久化。（H4）

#### Scenario: 空卷及容器重启
- **WHEN** 首次创建数据卷后启动并重启服务
- **THEN** 初始化及服务进程 UID 非零，数据可访问并保留，迁移不循环执行

### Requirement: 结构化滚动日志
服务 SHALL 通过共享日志规范输出脱敏 JSON 到 stdout，Docker 日志 SHALL 配置可调最大大小与保留份数，不记录密钥、验证链接或对话内容。（O1）

#### Scenario: 日志轮转
- **WHEN** 日志达到配置大小
- **THEN** 按保留份数轮转，保留 requestId 关联字段且无凭据值

### Requirement: 可选 Turnstile
系统 SHALL 保留模板 Turnstile 开关；关闭时认证正常可用且不要求其凭据、不渲染或校验 widget，但保留 IP/邮箱防刷。（H5）

#### Scenario: 关闭人机验证
- **WHEN** Turnstile 关闭且未提供其 secret/site key
- **THEN** Node 可启动并接受合法认证请求，超限请求仍被拒绝

### Requirement: 双目标 CI 与发布隔离
Cloudflare SHALL 保持主目标，既有测试、构建和 staging 自动发布不被替换或减少；Node CI SHALL 至少构建 web/jobs 并运行单元测试，不获得 staging 凭据或写入 staging。Node 集成 SHALL 在隔离 PG/缓存验收；依赖真实队列的完整认证 e2e MUST 等 B 后通过才能宣称 A 全部验收完成。（P6）

#### Scenario: PR CI
- **WHEN** A 的实施 PR 运行 CI
- **THEN** 现有 Cloudflare job 与新增 Node job 均验证，Node 不触发 staging 部署

#### Scenario: B 后认证验收
- **WHEN** B 的真实队列已经装配，在空卷本地 Compose 上启用验证邮件与多租户
- **THEN** 注册、通过真实队列收到验证邮件、验证、真实退出再登录及切换空间全部通过；未完成前对应任务保持待办

### Requirement: 多架构不可变镜像交付
CI SHALL 为 web、jobs、migrate 及官方 Compose 所需配套服务发布 linux/amd64 和 linux/arm64 镜像，默认 GHCR 且允许配置其他 OCI 仓库。镜像 SHALL 使用源码完整 git SHA 标签，版本内镜像与部署材料 SHALL 一致，正式 SHA 标签 MUST NOT 覆写。服务器 MUST 只拉取镜像，不构建源码。（P1）

#### Scenario: 两种架构发布同一版本
- **WHEN** 受信提交通过发布验证
- **THEN** 两架构均可拉取并运行同 SHA 的完整镜像集合，web/jobs 的版本与该提交一致，部署材料可追溯到同一 SHA

#### Scenario: 部分镜像构建失败
- **WHEN** 任一必需服务或架构构建/验证失败
- **THEN** 发布流程失败，不将不完整的版本声明为可部署 release，不改变上一成功版本

### Requirement: 迁移受控的 Compose 发布
交付 SHALL 提供 SSH 部署脚本或工作流，使用 `docker compose pull && docker compose up -d` 更新显式目标版本。同一部署 SHALL 串行发布，新应用 MUST 在目标迁移成功且旧 jobs 已安全退出后启动；迁移失败 MUST 阻止目标应用启动并报告失败，数据卷 MUST 保留。（P2）

#### Scenario: 已有版本升级
- **WHEN** 操作者发布新 SHA
- **THEN** 拉取预构建镜像，停止并确认旧应用退出，重新执行目标迁移，成功后启动应用；服务器无需编译或安装项目依赖

#### Scenario: 目标迁移失败
- **WHEN** 迁移非零退出
- **THEN** 新应用不启动，流程非零退出并保留数据库与失败诊断，不循环迁移以掩盖错误

### Requirement: 发布版本检查与可操作回滚
部署 SHALL 限时检查公开 `/api/health` 的成功状态、完整 SHA 和 Node 依赖 readiness，并核对 jobs 版本。失败 SHALL 非零退出、报告脱敏版本差异和上一成功版本的回滚命令。回滚 MUST 保留数据，只在代码/schema/持久任务兼容时执行；不兼容 SHALL 指向匹配备份恢复，不自动降级数据库。（P3）

#### Scenario: 旧版本或依赖故障
- **WHEN** health 返回旧 SHA、503、任务版本不同或在期限内未就绪
- **THEN** 部署失败，成功版本记录仍指向前版本，并输出可执行的回滚入口与兼容性条件

#### Scenario: 兼容版本回滚
- **WHEN** 操作者选择已记录且与数据库和任务兼容的上一版本
- **THEN** 拉取对应版本并重新检查 health/任务版本，不删除卷或执行破坏性 down migration

### Requirement: 同一 Compose 的可选运维层
plain Compose SHALL 为完整官方交付。Dokploy SHALL 可导入同一 Compose，关闭内置代理并使用自身 Traefik；它 MUST NOT 成为运行依赖。外部代理或 cloudflared SHALL 只接入专用入口网络，数据服务 MUST 不因此暴露宿主端口或接入代理网络。

#### Scenario: Dokploy 导入
- **WHEN** 在已授权且资源充足的环境使用 Dokploy
- **THEN** 同一 Compose 经配置只将 web 内部端口交给 Traefik，保留迁移 gate、secret 隔离和受限可信代理配置

#### Scenario: 使用现有代理
- **WHEN** 关闭 Caddy 并接入现有代理或隧道
- **THEN** 应用可通过内部入口访问，不新占用已有公网端口，PG/缓存/jobs 无新增外部端口

### Requirement: 空白服务器单命令初始化
交付 SHALL 为受支持的全新 Ubuntu/Debian 提供单命令初始化，安装 Docker Engine/Compose v2、启用开机启动、配置仅 22/80/443 入站并生成无真值 `.env` 骨架。重复执行 MUST 保留已有配置/数据；检测到生产服务或端口/资源冲突 MUST 停止自动初始化并给出明确原因。（P4）

#### Scenario: 全新虚拟机初始化
- **WHEN** 操作者在支持的空白 VM 上运行入口
- **THEN** Docker/Compose 可用、SSH 连通、实际外部入站仅为允许端口，生成骨架并指出 secret/TLS 后续配置

#### Scenario: 已用生产服务器
- **WHEN** 主机已有容器、冲突规则或资源不足
- **THEN** 初始化非零退出，不覆盖配置、不清空防火墙、不安装或接管 Dokploy

### Requirement: 主机重启后版本与持久状态恢复
主机重启后全部常驻服务 SHALL 自动恢复，已有数据及未完成任务状态 SHALL 保留，公开 health SHALL 在限定等待后返回成功与目标完整 SHA。恢复 MUST 遵守可信执行者退出和同版本任务恢复约束，一次性成功迁移 MUST 不循环执行。（§6.8）

#### Scenario: 服务器实际重启
- **WHEN** 已成功部署的测试服务器按获准窗口重启
- **THEN** 无手工修补即可恢复全部常驻服务，health 与 jobs 为目标 SHA，持久任务按既定契约恢复且无重复业务结果

#### Scenario: 尚无主机决策或生命周期签收
- **WHEN** 用户未决定目标主机/入口/运维方式，或容器及宿主重启退出证据未签收
- **THEN** 对应服务器/恢复验收保持 BLOCKED，不连接现有 ECS，不以本地进程测试宣称服务器验收完成
