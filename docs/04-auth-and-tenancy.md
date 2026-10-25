# 04 · 认证与多租户

## 1. 认证（Better Auth）

### 登录方式（由 `template.config.ts` 开关）
- 邮箱 + 密码。**默认不强制验证邮箱**（`auth.requireEmailVerification = false`）：注册后即可登录使用，注册时不发送验证邮件；用户领取注册赠送积分时才触发验证（发送验证邮件，验证完成后发放，见 05-billing §4「注册赠送防刷」），也可以在账号设置中主动验证。设为 `true` 时注册即发送验证邮件，未验证不能登录。OAuth 提供方返回已验证邮箱的账号直接视为已验证。
  - 「发送验证邮件」入口：`POST /api/auth/send-verification-email`（`{ email, callbackURL }`，客户端为 `authClient.sendVerificationEmail`），账号设置与领取注册赠送积分都用它；已登录时只能为自己的邮箱发送，免 Turnstile，但与其他发信入口一样按 IP + 邮箱限流。
  - 强制验证时，未验证账号的密码登录返回 403 `EMAIL_NOT_VERIFIED`，并自动重发一封验证邮件（`sendOnSignIn`）；点击链接后自动登录。实现见 `packages/auth/src/email-verification.ts`。
- 邮箱验证码（`emailOTP` 插件，开关 `auth.emailOtp`）
- 魔法链接（`magicLink` 插件，开关 `auth.magicLink`）；两者可同时开启
- OAuth：Google、GitHub（可扩展其他 provider）
- 可选：两步验证（`twoFactor`）、Passkey（后续）

### 插件
| 插件 | 用途 |
|---|---|
| `organization` | Workspace、成员、邀请、角色 |
| `admin` | 平台角色（user/admin）、封禁、模拟登录（impersonate） |
| `apiKey` | 公开 API 的密钥（`features.publicApi=true` 时启用） |
| `emailOTP` | 邮箱验证码登录（`auth.emailOtp`） |
| `magicLink` | 魔法链接登录（`auth.magicLink`） |
| `twoFactor` | 可选 |

### 跨运行时适配要点
- 每个请求创建 `auth` 实例（`createAuth(env, db, deps)`），env 仅含标量配置；`deps.cache`、`deps.rateLimiter`、`deps.clientIp` 由可信入口注入。内部用本请求的 Drizzle facade（Drizzle adapter，provider `pg`）；Node facade 借用进程池，CF 使用请求客户端。
- web 认证与空间入口通过 `getWebRuntime()` 获取认证、数据库和请求元数据；CF adapter 在 `apps/web/src/server.ts` 装配。Node 装配与持久邮件队列接入由后续任务负责。入口签名与其他模块迁移指引见 [平台能力与交接](platform-capabilities.md)。
- **会话读取的分层**（`packages/auth/src/session.ts`）：
  1. `session.cookieCache`（签名 Cookie，`maxAge` 5 分钟）：普通 Better Auth 会话读取可不读 KV、不查库；应用页面使用下述实时守卫。
  2. `secondaryStorage` 接 KV（绑定 `CACHE`，键前缀 `auth:`）：cookie 缓存过期后读 KV，减少跨地域查库；KV 未命中时回退查库。
  3. 同时保留数据库中的 session 表（`session.storeSessionInDatabase`），作为吊销与审计的事实来源。
  - 吊销必须经 Better Auth（退出登录、撤销会话、封禁、改密码等），它同时删除数据库行与 KV 副本。只在数据库中删除会话行（如手写 SQL）不会删除 KV 副本，KV 中的会话会一直有效到其 TTL（会话过期时间）；运维脚本需同时删除 `auth:<token>`。
  - 验证码、魔法链接、重置密码等验证值只从数据库签发、读取并原子消费（`verification.storeInDatabase`）。删除插件排除 secondaryStorage 的 `verification:` 键，防止旧缓存验证码绑定到同邮箱重新注册的账号；历史 KV 验证值不再读取，按原 TTL 到期。会话缓存仍保留。
  - Better Auth 1.7.7 的 OTP / 魔法链接单次消费预留使用非 UUID 主键，不能直接写入本项目的 UUID 列。`verificationReservation` 在请求执行前替换内部预留方法：按原始 identifier 获取事务锁，未过期预留只允许一个请求成功，新行用 UUIDv7；过期预留可重新使用。真实未验证邮箱的 OTP / 魔法链接登录保留 Better Auth 的凭据清理行为，不通过预先设置已验证来绕过。
  - 业务 TTL 向上取整为至少 1 秒；CF adapter 按 KV 约束提升至至少 60 秒，Node Valkey 保留秒级 TTL。两端共用 `auth:` 键前缀，Node 环境/用途命名空间由 cache adapter 隔离。
  - Better Auth 自带的 rateLimit 改用 isolate 内存，不存 KV：每个请求写同一个键会触发 KV「同一键每秒最多写 1 次」的限制，且计数最终一致。认证入口的限流以 `RL_AUTH` 为准（见下文）。
- **吊销不是即时的**：KV 的写入和删除传播到所有边缘节点最多约 60 秒，再叠加 cookie 缓存的 `maxAge`，改密码 / 封禁 / 踢下线后，旧会话最长可能还有效「cookieCache maxAge + 约 60 秒」。可接受的场景照常使用；以下**敏感操作不走缓存，直接查库**校验会话与 `user.banned`：
  - 修改密码 / 邮箱 / 2FA、删除账号
  - 计费操作（结账、取消订阅、门户）、成员与角色管理、创建 API Key
  - `/admin` 下的所有请求
- **实时校验的实现**（`packages/auth/src/fresh-session.ts`）：`requireFreshSession({ auth, db, headers })` 只从签名 Cookie 取会话 token（校验 HMAC 签名），会话与用户直接查库；会话不存在或已过期返回 401 `SESSION_REQUIRED`，用户被封禁（`banned` 且 `banExpires` 为空或未到）返回 403 `USER_BANNED`。业务代码（计费、`/admin`、成员管理的 server function 等）在 handler 开头调用它。Better Auth 自带的敏感接口（`/change-password`、`/change-email`、`/two-factor/*`、`/delete-user`、`/revoke-*`、`/admin/*`、`/api-key/create`、organization 的成员与邀请管理）由同文件中的插件在执行前做同样的校验——Better Auth 的 `sensitiveSessionMiddleware` 只绕过 Cookie 缓存，仍会读 KV。

### 密码哈希（2.4 实测，2026-10-04）

**结论：改用 PBKDF2。** Better Auth 默认的 scrypt（N=16384、r=16、p=1，workerd 中走 `node:crypto` 原生实现）在本地 workerd 中单次约 36 ms，注册 / 登录约 47–49 ms（p95 超过 50 ms），修改密码要算两次，约 81 ms，超过 design.md 设定的 50 ms 阈值。改为 Web Crypto 的 PBKDF2-HMAC-SHA256（100,000 次迭代，`packages/auth/src/password.ts`）后，注册 / 登录 / 修改密码约 16–21 ms。哈希格式为 `pbkdf2-sha256$<迭代次数>$<salt>$<hash>`，校验时兼容 scrypt 格式的旧哈希。

测量方法：`pnpm --filter @product-res/auth probe:cpu`（`packages/auth/probe/`），在 vitest-plugin 的 workerd 中经 `auth.handler` 执行完整流程，每项 20 次（另有 3 次预热），共 3 轮；关闭 Turnstile 与 RL_AUTH。单位 ms，三轮 p50 的范围（p95 的范围）：

| 项目 | scrypt | PBKDF2（100k） |
|---|---|---|
| 哈希原语 | 37（39–45） | 7（7–8） |
| 校验原语 | 37（38–52） | 6–7（7） |
| 注册 | 49–71（54–95） | 16–21（22–25） |
| 登录 | 47–64（51–91） | 16–25（27–41） |
| 登录（密码错误） | 42–61（44–71） | 11–13（12–15） |
| 修改密码 | 81–84（90–117） | 20–24（22–28） |

对照：绕过 Cookie 缓存的 `get-session`（KV 命中）与单次 `select 1` 的 p50 均为 0 ms（p95 ≤ 7 ms），因此流程耗时几乎全是 CPU，可作为本地 CPU 时间的上限。第 2 轮整体偏高，是本机同时有其他负载。

**本地测量与线上的差异**：
- 本地 workerd 的时钟在纯计算期间会推进，可以在 Worker 内计时；线上 Workers 的时钟只在 I/O 后推进，Worker 内无法这样测 CPU 时间，需看 Workers 日志 / Tail 的 `cpuTime`。
- 本机为 Apple M4，线上边缘服务器单核性能通常更低，同样的哈希会更慢；scrypt 本地已超阈值，线上只会更高。
- 计时是墙钟时间，含本地 PG 与 Miniflare KV 往返（对照组显示不到 1 ms）；线上 CPU 时间不含 I/O 等待。
- Cloudflare 文档规定 Workers 的 PBKDF2 最多 100,000 次迭代，本地 workerd 并不限制（实测 100,001 次被接受），因此迭代次数取 100,000，不随本地结果调高。100,000 次低于 OWASP 对 PBKDF2-SHA256 的建议（600,000），是 Workers 平台上限下的折中；迭代次数随哈希保存，平台放宽后可调高，已有哈希不受影响。
- staging 实测（2026-10-04，Wrangler tail 的单次样本，非 p95）：成功注册 `cpuTime` 为 85 / 54 ms、墙钟为 6966 / 5347 ms；成功密码登录为 40 ms / 2682 ms，错误密码登录为 60 ms / 390 ms。已使用 PBKDF2；注册 CPU 仍高于本地测量，样本不足以作为稳定基准。远程浏览器验收将等待预算设为 30 秒，避免沿用本地 5 秒断言时截断尚未完成的跨地域请求；业务断言不变。
- Cookie：`SameSite=Lax`、`Secure`；使用自定义域名，web 与 API 同源，避免跨站 Cookie 问题。
- **防刷**（`packages/auth/src/protection.ts`）：注册（`/sign-up/email`）、登录（`/sign-in/email`、`/sign-in/email-otp`、`/sign-in/magic-link`）、发送验证码（`/email-otp/send-verification-otp`）、找回密码（`/request-password-reset`、`/forget-password/email-otp`、`/email-otp/request-password-reset`）以及发送验证邮件（`/send-verification-email`）在接口执行前依次检查：
  1. 平台 `rateLimiter.limit('auth', key)` 按可信入口注入的客户端 IP 限流（CF 入口取 `cf-connecting-ip`，Node 入口按 TCP peer / trusted CIDR 解析，不读取客户端伪造的 CF/XFF 头）；
  2. Turnstile（`auth.turnstile=true` 时）：请求头 `x-turnstile-token`，服务端调用 siteverify（带 `remoteip`），缺失、无效或 siteverify 不可达都返回 403 `TURNSTILE_FAILED`；已登录用户调用 `/send-verification-email` 时免检；
  3. `RL_AUTH` 按邮箱（规范化后 SHA-256）限流。
  超限返回 429 `RATE_LIMITED`；Node Valkey 不可达返回脱敏 503 `CACHE_UNAVAILABLE`，不放行或退回内存。关闭 Turnstile 时无需 secret/site key、不校验令牌，但保留 IP/邮箱限流。不通过时接口本身不执行，不会创建用户或发送邮件；服务端直接调用 `auth.api.*` 不经过这些检查。CF 限额在 `wrangler.jsonc` 的 `ratelimits` 中配置（当前每个 key 每 60 秒 10 次）。
- 本地开发与测试：Turnstile 使用 Cloudflare 官方测试 secret（`1x0000000000000000000000000000000AA` 始终通过、`2x0000000000000000000000000000000AA` 始终失败，见 `apps/web/.dev.vars.example`）；集成测试按官方文档的行为模拟 siteverify，不访问外部服务。`CACHE` 与 `RL_AUTH` 由 Miniflare 模拟。
- 注意 Rate Limiting 绑定的计数是**按 Cloudflare 数据中心分别统计、最终一致**的，不是全局精确计数，只用来防刷和削峰。

### 邮件
验证邮件、OTP、重置密码、邀请邮件均通过 `EMAIL_QUEUE` 异步发送；OTP 类邮件若对时效敏感也可同步直发（Resend HTTP API）。

## 2. 平台角色 vs 空间角色

| 层级 | 角色 | 能力 |
|---|---|---|
| 平台（`user.role`） | `user` | 普通用户 |
| | `admin` | 进入 `/admin`：用户管理、订单、积分调整、模型配置、系统设置、模拟登录 |
| 空间（`member.role`） | `owner` | 全部权限，含账单、删除空间、转让 |
| | `admin` | 成员管理、使用 AI、查看账单 |
| | `member` | 使用 AI、查看自己的用量 |

权限判断统一在 `packages/entitlements` 的 `can(ctx, action)` 中实现，同时考虑：空间角色、套餐权益、空间状态（是否欠费/被封）。

## 3. 多租户：「个人空间」模型

### 核心规则
1. **所有业务数据归属 Workspace**（`organization`），从不直接归属用户。
2. 用户注册成功后（Better Auth `databaseHooks.user.create.after`）自动创建个人空间：`is_personal=true`，用户为 `owner`，并设为 `active_organization_id`。 个人空间的 id 与用户 id 相同，使补建在并发下保持幂等。
3. 计费主体是 Workspace：订阅、积分、订单都挂在 Workspace 上；积分流水额外记录 `user_id`。

### 开关行为

| 行为 | `multiTenant=false` | `multiTenant=true` |
|---|---|---|
| 个人空间 | ✅ 自动创建 | ✅ 自动创建 |
| 创建团队空间 | ❌ | ✅（受 `maxWorkspacesPerUser` 与套餐权益限制） |
| 邀请成员 | ❌ | ✅（仅团队空间） |
| 空间切换器 UI | 隐藏 | 显示 |
| URL | `/app/$slug/...` | `/app/$slug/...` |
| 席位计费 | — | 可选（权益 `maxSeats`） |

实现方式：代码路径完全一致，开关只影响 **UI 可见性** 与 **创建/邀请接口的准入校验**。关闭开关后已有的团队空间保持只读可访问（避免数据丢失）。

**URL 统一为 `/app/$slug/...`**：个人空间注册时自动生成 slug（如 `u-` + 短随机串，用户可改）。不为 `multiTenant=false` 单独做一套不带 slug 的路由——两套路由会让「代码路径完全一致」不成立，而且中途打开开关会让已分享出去的链接全部失效。`/app` 本身只做重定向：跳到 `active_organization_id` 对应空间（没有则跳个人空间）。

### 团队准入与邀请（P1）
- `teamWorkspaces` 对原生 organization 写接口统一校验数据库会话、成员角色和开关；owner 锁按用户 ID 排序，再取空间事务锁。创建与转让均检查团队 owner 数量上限，团队 slug 不能使用保留字或个人空间的 `u-` 前缀。关闭多租户后团队只读，个人空间仍可修改名称。
- owner / admin 可以邀请和管理普通成员，授予或撤销 owner 角色仅允许 owner；不能移除、退出或降级最后一个 owner。转让先把目标设为 owner，再把发起者降为 admin。个人空间的成员关系不可修改。
- 接受邀请必须匹配当前数据库中的收件邮箱，并且该邮箱已经验证；全局允许未验证邮箱登录不等于允许接受邀请。未验证收件人返回 403 `INVITATION_EMAIL_UNVERIFIED`，成员和邀请不发生变更；签名 Cookie 中旧的验证状态不能覆盖数据库。邀请页面在验证前不展示空间名称或角色，提供真实验证邮件入口并回到原邀请 URL。
- **邀请链接**（`packages/auth/src/invite-links.ts`，openspec/changes/add-team-invite-links）：团队空间 owner / admin 生成可多人使用的 `/join/<token>` 链接，选择加入角色（member / admin，数据库约束禁止 owner）、有效期 1 / 7 / 30 天与可选人数上限，可随时作废。token 为 256 位随机值，`workspace_invite_link` 只存 SHA-256 哈希，完整链接只在生成时返回一次。加入不要求邮箱验证（内测无邮件），与邮件邀请、直接加成员共用 `owner:` → `ws:` 锁与席位计数；创建人不再是 owner / admin 时链接自动失效，团队软删时全部作废。预览与加入按 IP 与用户走 `RL_AUTH`，请求日志与 Sentry 中 `/join/` 路径经 `redactUrlPath` 脱敏，PostHog 不采集 `/join`。审计：`workspace.invite_link_created` / `workspace.invite_link_revoked` / `workspace.member_added`（meta 带 `inviteLinkId`）。

### 当前空间的解析
- 优先级：URL 中的 `$slug` → session.active_organization_id → 用户的个人空间（后两者只用于 `/app` 的重定向）。
- `withWorkspace` 中间件解析后**每次请求查库**校验成员身份（不使用会话缓存中的数据，避免被移出的成员在缓存有效期内仍可访问），把 `{ workspace, member }` 注入上下文。

### 席位
- 接受邀请、新增成员时与 AI 任务提交一样，先取空间级事务锁 `pg_advisory_xact_lock(hashtextextended('ws:' || $ws, 0))`，再在同一事务内检查 `count(member) < maxSeats` 并插入，避免并发接受邀请导致超员。
- P1 的 `ResolveMaxSeats(workspaceId, sql)` 提供同一事务读取本地权益的接入点；web 共用 `resolveWorkspaceMaxSeats`，按有效订阅 / `free` 套餐的 `maxSeats` 计算（内测 `free` 为 10 席，见 add-team-invite-links D1）。接受邀请与直接新增成员共用锁和计数，测试验证最后一个席位并发时仅一人成功。
- 降级到席位更少的套餐时不自动移除成员：超员期间禁止新增成员，并在空间设置页提示 owner 处理。

### 数据隔离
- **共享库 + 共享表 + `workspace_id` 列**。
- `scoped(db, workspaceId)`（`@product-res/db`）返回预绑定过滤条件的查询工具：`select` / `count` / `findById` / `insert`（自动填入空间 id）/ `update` / `delete` / `updateById` / `deleteById` / `transaction`；按 id 访问其他空间的记录与访问不存在的记录一样抛出 `NOT_FOUND`（404），不泄露记录是否存在。
- 禁止绕过：Biome GritQL 插件 `packages/db/lint/no-unscoped-workspace-query.grit` 在 `apps/web/src/features/**` 与 `apps/jobs/src/**`（不含测试）中拦截对带空间列的表的直接 `db.select().from(t)` / `insert` / `update` / `delete` / `db.query.t`，随 `pnpm check` 在 CI 中执行。新增带 `workspace_id` 的表时须同步插件中的表清单（有测试对照 schema 校验）。确需跨空间的系统任务用 `// biome-ignore lint/plugin: <理由>` 显式豁免。
- Postgres RLS 作为**可选加固**：事务内 `SET LOCAL app.workspace_id = ...` + 策略。Hyperdrive 以事务为单位复用连接，`SET LOCAL` 在事务内安全（待验证）；默认不启用以降低复杂度。
- R2 对象 key 以 `ws/{workspaceId}/...` 为前缀，下载一律经服务端鉴权后签发短期 URL。

## 4. 删除账号与空间

财务与审计数据必须保留，因此删除一律是「软删 + 匿名化」，不物理删除 `user` / `organization` 行（外键策略见 03-data-model §7）。

应用页面的 `withSession` 也直接调用 `requireFreshSession` 后再解析空间；上文缓存延迟仅适用于普通 Better Auth `getSession` 读取。个人空间补建在 owner 锁内检查封禁与软删，不会重新加入已删除空间。

**P1 已实现的删除流程**（`packages/auth/src/deletion.ts`）：
- `POST /api/auth/deletion/workspace` 仅允许团队 owner；实时查库验证会话、权限和空间状态，在事务中软删空间、取消 pending 邀请、移除全部成员、禁用空间 API Key，并清空指向该空间的活跃会话。`workspace.deleted` 审计记录保存 `originalOwnerUserIds`。
- `POST /api/auth/deletion/account` 要求十分钟内的真实登录；用户仍是团队唯一 owner 时拒绝并返回空间列表。个人空间软删、退出团队，用户邮箱改为 `deleted+{id}@invalid`，清空姓名、头像、语言和时区，删除密码/OAuth、会话、2FA、API Key 和属于该用户的验证值，永久封禁匿名账号。同一邮箱可重新注册全新账号。
- 删除钩子 `registerDeletionStep` 分为事务前的外部检查与事务内数据库执行；失败不会绕过检查，事务内失败回滚数据库变更。审计和财务引用继续指向原 user/organization 行。

删除事务同时把待失效的会话键写入专用 `verification.identifier=deletion-cleanup:<id>` 临时清理记录，保留 24 小时。KV 操作在事务提交后执行；失败明确返回 `deletionCompleted=true`，不会把已经完成的删除误报为回滚。jobs 的 `CACHE` 与 web 共用命名空间，五分钟内重试；成功移除记录，过期记录丢弃，缓存本身按会话 TTL 到期。原会话在数据库已吊销，应用和敏感操作始终拒绝。清理记录不含验证码键，不影响同邮箱新账号的验证值，也不写入永久审计日志。

**P1 恢复与到期清理**（`packages/auth/src/workspace-lifecycle.ts`）：
- `workspaceLifecyclePlugin(db, config.tenancy.maxWorkspacesPerUser)` 由 `createAuth` 挂载，提供 `POST /api/auth/admin/restore-workspace`（`{ workspaceId }`）；函数 `restoreWorkspace` 同样使用签名 Cookie 的数据库会话。仅当前平台 admin 可以恢复，拒绝模拟登录；事务内再次校验并锁住管理员会话和用户行，封禁、吊销或降权立即生效。
- 默认保留 30 天，期限从 `organization.deleted_at` 计算；到期即拒绝恢复，即使每日清理还未运行。按排序后的原 owner ID 获取 owner 锁，再获取空间锁。只恢复删除审计中仍有效的原 owner；已匿名化、永久封禁或仍在临时封禁期的 owner 不恢复，没有有效 owner 则拒绝。团队恢复遵循 `maxWorkspacesPerUser`，任何有效原 owner 达到上限时整体拒绝；个人空间不计团队上限。其他成员须重新邀请，旧邀请、API Key 和活跃会话不会恢复。
- jobs 每天 03:00 UTC（北京时间 11:00）执行 `cleanupExpiredWorkspaces`；每五分钟心跳先重试删除后的凭据缓存失效，再记录健康时间；失败会保留工作并在下一次心跳重试。P1 实际存在的空间内容表只有 `notification` 与 `invitation`，到期后删除这两类记录，永久保留 user、organization、全部 audit_log。事务内 `workspace.cleanup.completed` 审计关联本次 `workspace.deleted` 的 ID，重复运行不重复清理，已经清理的删除周期不能恢复。

**退款决策与后续阶段**：删除默认不退款。P1 删除确认文案说明默认不退款，并通过配置的支持邮箱引导用户联系客服；P1 没有付款查询或 `refund_request` 创建接口。P2 在 billing change 中实现续费订阅检查、个人订阅立即取消、积分 revoke 流水、按 `refundWindowDays` 提示先申请退款及 `refund_request`；已提交申请须继续保留并使用申请时的联系邮箱。注册赠送积分的邮箱哈希去重也属于 P2。P3/P4 在实际新增对话、AI 任务、文件和 R2 对象后接入运行中任务检查与到期内容清理，P1 不操作尚未存在的表或存储对象。

## 5. 后续扩展
- 租户自定义域名：Cloudflare for SaaS（Custom Hostnames）。
- 空间级 SSO / 审计导出：面向 B2B 时再做。
