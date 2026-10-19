# 提案：Cloudflare Tunnel 入口（add-tunnel-ingress）

## 为什么

product.ezarouter.cc 的 DNS 由 Cloudflare 管理，原先就通过 Tunnel 访问。自托管发布目前只支持
Caddy 直连（DNS 灰云 + 公网 80/443 + ACME），或接入“已存在的外部代理”。我们希望：

- 不开放服务器公网 80/443，不暴露源站 IP；
- 由 Cloudflare 负责 HTTPS 与 DNS（Tunnel 的 public hostname 自动维护 CNAME）；
- cloudflared 与其他服务一样随发布交付（固定 digest、双架构、受部署脚本管理），而不是服务器上手工起的容器。

## 改什么

- 镜像清单新增 `cloudflared` 服务（第 9 个镜像）：基于官方镜像固定 digest，非 root，双架构构建与 smoke。
- 新增 Compose 叠加文件 `compose.tunnel.yaml`：启用 cloudflared、停用内置 Caddy 且不占用宿主端口，
  cloudflared 只接 ingress 网络并以固定地址访问 `web:3000`；web 只信任该地址的转发头。
- Tunnel token 作为独立文件 secret，只挂给 cloudflared。
- 发布 bundle 与 deploy.py 白名单纳入该叠加文件；部署命令追加 `--compose-file compose.tunnel.yaml`。
- 文档：proxy runbook、`.env.example`、`secrets.example`。

## 不改什么

- 默认交付仍是 Caddy 直连；不加载叠加文件时行为不变。
- 不改应用代码的客户端 IP 解析逻辑（`packages/platform/src/node/request.ts` 已按可信 CIDR 从右向左解析 XFF）。
- 不引入 Cloudflare Access 等额外鉴权。

## 风险

- Cloudflare 边缘对单个请求约 100 秒超时，长时间 AI 生成可能被切断（与橙云相同）。
- 客户端 IP 依赖 Cloudflare 在 XFF 末尾追加真实来源地址；必须在真实 Tunnel 上验证后才算验收。
- cloudflared 不可用时站点整体不可达；健康门需要能区分“应用健康”与“隧道连通”。
