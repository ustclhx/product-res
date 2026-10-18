# Email

`@product-res/email` 提供 React Email 模板、`EmailSender`、fetch Resend sender；
`@product-res/email/queue` 是不加载模板的 producer 消息入口。
Node SMTP 仅从 `@product-res/email/node` 显式导入，锁定 **Nodemailer 10.1.0**（自带类型）。
中立入口与 CF consumer 不导入此子入口。

```ts
import { createSmtpSender } from '@product-res/email/node'

const sender = createSmtpSender({
  host: 'smtp.example.com',
  port: 587,
  tlsMode: 'starttls',
  from: 'product-res <noreply@example.com>',
  replyTo: 'hxl15380@gmail.com',
  // user/password 由 composition 显式传入；可以同时省略以使用受控匿名中继。
})
```

Adapter 不读取 env，不执行启动联通探测；本地非法配置立即抛不可重试的
`EmailSendError`，服务不可达留给已有队列处理。只从 `EmailMessage` 复制
to/subject/html/text/replyTo、两项 List headers 和稳定身份，不接受附件或任意
Nodemailer transport 配置；禁用文件/URL 内容读取、debug、logger、transactionLog。
`replyTo` 优先使用消息值，再使用 sender 默认值。模板及渲染结果保持现有实现。

## TLS 与错误策略

| 模式 | 行为 | 常用端口 |
| --- | --- | --- |
| `implicit` | 建连即 TLS，验证证书和主机名 | 465 |
| `starttls` | 强制升级 TLS，升级失败拒绝发送，不降级 | 587 |
| `none` | 显式明文，忽略 STARTTLS，仅限受控内网中继/本地测试 | 按部署指定 |

端口必须显式提供，允许 1–65535；模式不由端口推断。TLS 最低 1.2，始终
`rejectUnauthorized: true`，没有关闭证书验证的 adapter 选项。内部 CA 可由
Node 启动时的信任存储提供；测试仅在独立子进程中传入临时 CA。
选项依据 [Nodemailer SMTP transport](https://nodemailer.com/smtp)。

每封邮件使用独立连接，不池化，不自行重试或跨通道补发。默认连接（包括 DNS）
10 秒、greeting 10 秒、socket 空闲 30 秒；可通过 `connectionTimeoutMs`、
`greetingTimeoutMs`、`socketTimeoutMs` 显式设置 100–60000 毫秒。
这些是各阶段/空闲期限，不承诺总投递墙钟时间；并发与停机总预算由队列/runtime 控制。

按 [Nodemailer error reference](https://nodemailer.com/errors) 的 `responseCode`
优先分类，保留为 `EmailSendError.status`（SMTP 状态码）：

| 结果 | retryable | 安全 message |
| --- | --- | --- |
| 4xx（包括 451、认证 454） | true | `SMTP_TEMPORARY_FAILURE` |
| 5xx（包括认证 535、收件人 550） | false | `SMTP_PERMANENT_FAILURE` |
| 无 SMTP 状态的连接失败、超时、断流、TLS 验证失败 | true | `SMTP_CONNECTION_FAILED` |
| 本地非法配置 | false | `SMTP_CONFIG_INVALID` |
| 非法消息/地址/头部换行 | false | `SMTP_MESSAGE_INVALID` |
| 无 SMTP 状态的认证/配置/信封/内容访问错误 | false | `SMTP_MESSAGE_OR_CONFIG_INVALID` |

客户端 EAUTH/EENVELOPE 不覆盖 4xx 临时状态。原始响应、message、收件人、
正文、密码和驱动 cause 均不进入错误。成功返回 `{ id: messageId }`，不返回响应正文。
多收件人部分拒收会作为失败，优先保留可重试拒收结果；重投可能重复送达已经接受的地址。

同一个 from 与 `idempotencyKey` 生成相同的哈希 Message-ID，不暴露邮箱或业务键。
SMTP 服务不保证去重，DATA 被接受后、本地确认前崩溃或断连仍可能重复投递。
Resend 继续使用原始稳定幂等键与其服务端去重窗口。持久 inbox/DLQ 保持原契约：
首次加最多五次重试，30 秒指数退避封顶 900 秒，成功成员独立确认，
有效终态失败先写持久 DLQ 再确认；不会自动改用 Resend。

## 本地验证

```sh
pnpm --filter @product-res/email typecheck
pnpm --filter @product-res/email test
pnpm --filter @product-res/email test:node:smtp
```

最后一项需要 Docker、OpenSSL 和 `node:22.23.3-bookworm-slim` 镜像。
fixture 只监听发布到 127.0.0.1 的随机端口，不转发邮件；容器名包含
`selfhost-c-smtp`，runner 结束清理自己的容器与临时 CA/私钥。
可信/不可信/主机名错误证书均在运行时生成，不提交密钥。
真实协议用例覆盖模板/MIME、from/replyTo/list headers、TLS 与不可降级、
451/454/535/550、超时/断流脱敏及稳定身份，默认 `test` 不启动 Docker。
中立冷导入测试阻止 Nodemailer 加载；既有 workerd 渲染测试和 CF 构建验证中立导入。

## 认证邮件持久链路验收（C 3.4）

仓库根目录运行：

```sh
node apps/web/test/node/run-auth-smtp.mjs
```

需要 Docker、OpenSSL，以及本地 `postgres:17`、`valkey/valkey:8.1.6-alpine`、
`node:22.23.3-bookworm-slim` 镜像。Runner 创建独占 PG/Valkey/SMTP，随机端口仅绑定
127.0.0.1，应用角色保留既有 DML 权限，迁移由 migrator 执行。容器名包含
`c-verify`；退出清理自己的容器和临时 HTTPS 证书。SMTP 只在内存捕获，
不转发外部邮箱，不保存正文或认证链接。默认 CF 测试不收集这个 `.node.ts` 文件。

这是实际 Node HTTPS 请求经源码 `createNodeWebProcess` / `handleAuthRequest`，
连接实际 inbox、DBOS、`startNodeJobs`、模板渲染和 SMTP sender 的集成验收；
没有运行打包后的 Nitro 服务、浏览器 UI 或 Compose 发布栈。测试只替换模板开关：
禁用 Turnstile/OAuth/支付和 AI，开启注册邮箱验证。HTTPS 使用临时受信 CA，
SMTP `none` 仅在本地隔离 fixture；生产 TLS 见上面的真实协议测试。

注册请求在 SMTP 返回 451 时仍成功入队并返回 200，经生产 30 秒退避送达，
从实际收到的 MIME text/plain 提取并点击验证链接，再经 HTTP 登录确认邮箱已验证。
重置请求同样返回 200；fixture 保存完整 DATA 后故意断连，客户端收不到最终 250，
持久 inbox 保留 pending。原队列消息经相同 30 秒退避重试，产生两次收件记录，
两次 Message-ID 和重置链接完全相同。随后点击收到的链接并提交新密码，
验证旧密码拒绝、新密码成功、旧会话 token cookie 失效；普通 Cookie 缓存仍遵循
原五分钟吊销延迟。测试不查询 verification token，也不从 inbox body 取得链接。

成功运行生成脱敏证据
[`c-3.4-auth-smtp.json`](../../docs/runbooks/evidence/selfhost/c-3.4-auth-smtp.json)，
包含完整 HEAD、请求/inbox/Message-ID、收件时间、尝试次数、状态和零 Resend 调用。
SMTP 接受后确认前存在不确定结果，可能重复投递；稳定 Message-ID 只提供身份追踪，
不能保证接收服务去重，也不承诺 exactly-once。

## 已装配共享接线（C 3.1–3.3）

1. **`packages/config/src/node-schema.ts`**：Node 专用 schema 接受
   `EMAIL_TRANSPORT=log|resend|smtp`，默认仍为 `log`。保持 CF 的 `withEmailEnv`
   与 `EMAIL_TRANSPORTS=log|resend` 不变；Node schema 不再经该 helper 把 enum
   覆盖回 CF 枚举。`nodeEnvSchema` 与 `nodeEnvSchemaFor` 共用 Node 邮件校验。
   新增 `SMTP_HOST`（hostname/IP，非 URL、无凭据/空白/路径）、`SMTP_PORT`
   （coerce 整数 1–65535，无默认）、`SMTP_TLS_MODE`
   （`implicit|starttls|none`，默认 `starttls`）、`SMTP_USER`/`SMTP_PASSWORD`
   （非空可选）；smtp 时 host/port/`EMAIL_FROM` 必填，user/password 同时存在或均缺。
   from 验证为单一邮箱（允许显示名），replyTo 为单一邮箱；显式 resend 时仍要求
   `RESEND_API_KEY`/`EMAIL_FROM`。错误通过 `EnvValidationError` 只列字段名。
2. **固定文件密钥 allowlist**：在 `nodeSecretNames` 加入 `SMTP_PASSWORD`，复用
   `loadNodeEnv` 现有 `_FILE` 读取、直接值与文件值冲突/空文件/不可读文件拒绝规则。
   不为 host/port/user 加任意文件读取。配置示例由协调者在部署接线批次更新，
   `none` 必须写明仅受控内部中继/测试。
3. **`packages/config/src/node.ts`**：导出 Node 通道转换函数
   `nodeEmailTransportConfig(env)`，返回既有 log/resend 或 smtp 配置
   `{ transport: 'smtp', host, port, tlsMode, from, replyTo?, user?, password? }`；
   保留中立/CF `emailTransportConfig` 的现有行为与 Resend 稳定幂等键。
   Node 类型不需要导入 Nodemailer 或 email SDK。
4. **`apps/jobs/src/queues/email.ts`**：`handleEmailBatch` 接受
   `EmailTransportConfig | { readonly transport: 'smtp' }`，options 加
   `sender?: EmailSender`。log 分支保持；smtp 必须有 sender，否则立即安全报错，
   不回退。把已有“渲染结果→sender.send”映射提取为该函数内小型共用路径，
   让 Resend 和注入的 SMTP 都传原 to、subject、html、text、headers、idempotencyKey。
   本文件只 type import `EmailSender`，不 import `@product-res/email/node`。
5. **`apps/jobs/src/handlers.ts` / `JobsContext`**：emailTransport 按第 4 条加 smtp
   描述类型，新增 `emailSender?: EmailSender`，在 `consumeJobsBatch` 调用
   `handleEmailBatch` 时连同 observer/deadLetters 传入 sender。
   不改变首次+5次/30秒指数退避封顶900秒、同批独立确认和有效终态先持久DLQ规则。
6. **`apps/jobs/src/node/runtime.ts`**：启动、创建业务池之前调用 Node 通道转换；
   smtp 时由此 Node composition 显式 import `createSmtpSender`，传第 3 条字段，
   将通道描述和 sender 注入 context。无需 Resend key、不调用 verify、不在 web
   producer 装配 SMTP。包依赖 `@product-res/email` 已有，无需引入另一个发送器/队列。
   CF 入口、Node registration 和构建脚本无需 SMTP 专属修改。
7. **共享契约注释**：协调者同步 `EmailMessage.idempotencyKey` 注释，说明去重取决于
   通道，SMTP 只生成稳定身份；接口形状不变。补 config 缺项/非法值/认证配对/
   `_FILE` 冲突与无值泄漏测试，C 3.3 的真实 consumer 验收见 jobs `test:node:smtp`，C 3.4 见上面的认证链路。
