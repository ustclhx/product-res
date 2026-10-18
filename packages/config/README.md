# 运行时配置

Cloudflare 默认入口保持 `envSchema` / `loadEnv`：必须提供 HYPERDRIVE，app 可扩展绑定 schema，绑定保留原引用。三层配置仍分别属于模板代码、数据库 setting 和运行时密钥。

`billing.enabled`、`credits.enabled`、`marketing.enabled` 和 `i18n.enabled` 是模板开关，默认均为 `true`，只能通过代码修改后重新部署。关闭开关保留该模块其他字段的值；营销子功能仍由既有 `features` 字段控制，单语言使用 `i18n.defaultLocale`，关闭 i18n 不会改写语言列表。

计费启用要求积分启用；任一 AI 模态启用要求计费和积分同时启用，沿用现有套餐授权与积分结算，不建立替代额度。可以在 AI 全关时单独保留积分并关闭计费。团队工具全关组合应同时关闭三个 AI 模态；认证、空间和邮件配置继续独立生效。关闭计费不要求支付模式或支付凭据，也不应触发计费套餐 seed；入口、任务和 seed 接线由应用负责，不能仅清空 `billing.providers` 来关闭计费。现有显式 `_FILE` 错误规则仍适用。

Node composition root 从 `@product-res/config/node` 导入 `loadNodeEnv`，在 listen、连接池和任务处理器启动之前调用。此入口包含 Node 文件 I/O，不得导入浏览器、Vite define 或构建期预渲染代码。中立根入口只导出 schema/type，不读取环境或文件。

```ts
import { loadNodeEnv } from '@product-res/config/node'

// templateConfig 是应用的现有模板配置。
const config = loadNodeEnv({ templateConfig })
// 校验成功后才创建资源、装配业务上下文和监听端口。
```

未捕获的 EnvValidationError 会让启动非零退出；入口若捕获，只记录 missing/invalid 字段名并退出，不能输出 config、process.env、底层错误或重新继续 listen。应用 Node 入口接入由 change 组 5 完成，本包测试以真实 Node 子进程验证校验先于 listen。

| 配置 | Node 规则 |
| --- | --- |
| DATABASE_URL | 必需，postgres/postgresql 连接 URL，运行时只用 app 角色 |
| VALKEY_URL | 必需，redis/rediss URL |
| BETTER_AUTH_SECRET | 必需，至少 32 字符 |
| APP_URL | 必需，公开 HTTPS URL |
| DB_POOL_MAX | 正整数 1–100，默认每进程 10；PG 总预算另见 db 文档 |
| SHUTDOWN_TIMEOUT_MS | 正整数，默认 30000；由 composition root 用于 drain |
| CACHE_NAMESPACE | 非空，默认 saas；同一环境 web/jobs 使用同值 |
| TRUSTED_PROXY_CIDRS | 默认空；解析与信任边界由 platform/node 检查 |

默认读取运行目录的 `.env`；只有默认文件不存在可以省略。`dotenvPath` 指定路径时不可读会失败，`dotenvPath:false` 禁用文件读取。使用 Node 原生 dotenv 解析器，不执行 shell source。进程环境优先于 dotenv，包括显式空字符串；不会修改 process.env。schema 丢弃无关变量及 `_FILE` 路径。

`nodeSecretNames` 明确声明支持 `_FILE` 的密钥：DATABASE_URL、VALKEY_URL、BETTER_AUTH_SECRET、OAuth client secrets、TURNSTILE_SECRET_KEY、Stripe key/webhook secret、PAYPAL_CLIENT_SECRET、OPENAI_API_KEY、ANTHROPIC_API_KEY、GOOGLE_API_KEY、DEEPSEEK_API_KEY、FAL_KEY、AI_GATEWAY_TOKEN、RESEND_API_KEY。未知 `NAME_FILE` 不触发文件读取。直接值与文件路径在两层合并后同时存在即冲突（空直接值也算）；文件缺失、不可读或空内容启动失败。只去掉一个末尾 LF/CRLF，不 trim 密钥空格或多余换行。错误只含字段名，不含路径、取值或原始文件错误。

传入 `templateConfig` 时，仅启用的 OAuth/Turnstile 要求对应凭据；关闭 Turnstile 不要求 site key/secret。Resend 通道沿用现有 withEmailEnv 规则。支付模式保留字符串并交给支付入口 resolvePaymentMode 校验；支付/AI/Sentry 凭据缺失不阻断公开页或普通认证，现有业务工厂继续负责不可用判定与同进程一次的变量名告警。可选密钥若通过文件提供，其文件错误仍是部署错误。

禁止把配置对象序列化到前端或健康响应；只在服务器显式挑选公开 UI 字段。密钥不得放入 VITE_*、Docker ARG、镜像层或构建缓存。

验证：`pnpm --filter @product-res/config test`、`pnpm --filter @product-res/config typecheck`。
