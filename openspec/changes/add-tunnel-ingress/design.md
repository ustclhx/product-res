# 设计：Cloudflare Tunnel 入口

## 拓扑

```
用户 ──HTTPS──> Cloudflare 边缘 ──Tunnel(出站 QUIC/HTTP2)──> cloudflared ──HTTP──> web:3000
                                                        (ingress 网络，固定地址)
```

- 服务器不发布任何宿主端口；cloudflared 只发起出站连接。
- Tunnel 用 Cloudflare Zero Trust 控制台创建（remotely-managed），public hostname
  `product.ezarouter.cc → http://web:3000`；控制台自动维护 DNS CNAME。因此服务端只需要 token，
  不需要 ingress 配置文件。

## 镜像

- `deploy/selfhost/cloudflared.Dockerfile`：`FROM cloudflare/cloudflared:<版本>@sha256:<multiarch digest>`，
  不重新编译；加 OCI revision label，与其他服务一致经 check-bases 校验基础 digest。
- 运行用户沿用官方镜像的非 root UID（nonroot 65532），PID1 为 cloudflared。
- smoke：版本输出、UID 非 0、无 token 时拒绝启动并非零退出；不连接真实 Cloudflare。

## Compose 叠加 `compose.tunnel.yaml`

- `cloudflared`：`tunnel --no-autoupdate run`，token 通过文件读取（优先使用 cloudflared 的
  `--token-file`；若固定版本不支持，则选择不经 shell、不把 token 写入命令行或环境变量日志的等价方式，
  并在 PR 中说明）。只读根文件系统、`cap_drop: [ALL]`、`no-new-privileges`、重启策略与其他常驻服务一致。
  只接 `ingress` 网络并使用固定 IPv4 地址；不接 data 网络。
- `caddy`：与 `compose.proxy.yaml` 同样的方式停用（profile 覆盖、ports 清空）。
- `web`：`TRUSTED_PROXY_CIDRS` 固定为 cloudflared 的 `/32`。Cloudflare 边缘把真实来源追加到
  XFF 末尾，web 从右向左跳过可信地址后取到的即为边缘看到的客户端地址。
- 健康：cloudflared 开启 metrics/ready 端点（仅容器网络内），Compose healthcheck 若镜像无 shell/curl
  则使用 cloudflared 自带能力或省略并在部署健康门中通过公网 `/api/health` 证明隧道连通。

## Secret

- `secrets/cloudflared_tunnel_token`：0600，属主为 cloudflared 运行 UID；只挂给 cloudflared。
- 不进入 `.env`、日志、bundle 或 git。

## 发布与部署

- catalog 增加 `cloudflared`；首次发布时 `new_services=cloudflared`。
- `release/bundle.py` 运行文件清单与 checksum 覆盖 `compose.tunnel.yaml`；`deploy.py` 白名单接受它，
  且与 `compose.proxy.yaml` 互斥（两者都会停用 Caddy、各自定义入口）。
- 部署：`deploy.sh --host ... --compose-file compose.tunnel.yaml`。健康门的公网检查走
  `APP_URL`（经 Tunnel），jobs 内部 ready 不变。

## 验收

- CI：两架构构建与 smoke 通过；bundle/deploy 测试覆盖叠加文件、白名单与互斥。
- 真实环境（部署阶段）：公网 HTTPS 访问正常；从已知出口 IP 发请求，确认应用记录的客户端 IP 与之相符；
  伪造 `X-Forwarded-For` 不能改变结果；服务器无 80/443 宿主监听。
