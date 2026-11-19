# web-security-headers Specification

## Purpose
规定 web 应用返回给浏览器的安全响应头与 CSP 上线策略，防止点击劫持、MIME 嗅探与跨站内容注入，覆盖 Cloudflare 与 Node 两个运行目标。

## Requirements

### Requirement: 所有响应携带基础安全响应头
web 应用的每个 HTTP 响应（页面、Server Function、API、重定向、错误响应，Cloudflare 与 Node 目标一致）SHALL 携带：禁止被任何站点嵌入（`X-Frame-Options: DENY` 与 CSP `frame-ancestors 'none'`）、`X-Content-Type-Options: nosniff`、`Referrer-Policy: strict-origin-when-cross-origin`，并在 HTTPS 下携带 `Strict-Transport-Security`（至少一年，含子域名）。上游已设置同名头时 MUST NOT 被覆盖为更宽松的值。

#### Scenario: 后台页面被第三方站点嵌入
- **WHEN** 第三方页面用 iframe 加载 `/admin/users/<id>`
- **THEN** 浏览器拒绝渲染该页面

#### Scenario: 错误响应
- **WHEN** 请求触发未处理异常，返回 500
- **THEN** 响应仍携带上述安全响应头与请求 ID

### Requirement: CSP 分阶段上线
完整的内容安全策略 SHALL 先以 `Content-Security-Policy-Report-Only` 发布，在 staging 验证首页、登录（含 Turnstile）、结账跳转、对话流、媒体预览与错误上报均无违规后，才可切换为强制执行；策略来源 MUST 只列出实际使用的第一方与集成域名，MUST NOT 使用 `*` 通配全部来源。

#### Scenario: Report-Only 阶段
- **WHEN** CSP 处于 Report-Only 阶段，页面加载了策略外的脚本
- **THEN** 脚本照常执行，浏览器报告违规，用户功能不受影响
