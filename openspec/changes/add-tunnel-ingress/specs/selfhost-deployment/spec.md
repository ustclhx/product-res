## ADDED Requirements

### Requirement: Cloudflare Tunnel 入口叠加

发布 SHALL 提供可选的 `compose.tunnel.yaml`，以随发布交付的固定 digest cloudflared 镜像作为唯一公网入口。加载该叠加时，内置 Caddy MUST 停用且任何服务 MUST NOT 发布宿主端口；cloudflared MUST 只接入 ingress 网络并使用固定地址，MUST NOT 接入 data 网络；Tunnel token MUST 只以文件 secret 挂给 cloudflared，MUST NOT 出现在环境变量、命令行参数、日志或 bundle 中。web MUST 只信任 cloudflared 固定地址的转发头。该叠加 MUST 与外部代理叠加互斥。

#### Scenario: 隧道模式部署
- **WHEN** 部署命令追加 `--compose-file compose.tunnel.yaml` 且 token secret 存在
- **THEN** cloudflared 以非 root 运行并连接 Cloudflare，公网 HTTPS 经 Tunnel 访问 web，宿主无 80/443 监听

#### Scenario: 客户端地址
- **WHEN** 客户端经 Tunnel 访问并在请求中伪造 `X-Forwarded-For`
- **THEN** 应用记录的客户端地址为 Cloudflare 边缘观察到的来源地址，伪造值不生效

#### Scenario: 与外部代理叠加同时加载
- **WHEN** 部署同时指定 `compose.tunnel.yaml` 与 `compose.proxy.yaml`
- **THEN** 部署在任何服务变更前失败并说明二者互斥
