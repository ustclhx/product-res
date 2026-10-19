# 同一 Compose 的外部代理与 Cloudflare Tunnel 接入（D 2.4 / add-tunnel-ingress）

plain Compose 使用 release 中的 `compose.yaml`，`.env` 的 `COMPOSE_PROFILES=caddy`
启用 Caddy，只有它发布 80/443。PG/Valkey/web/jobs 不发布宿主端口。外部入口继续使用
同一文件，额外加载 `compose.proxy.yaml`；要求 Docker Compose **2.24.4+**（`!override`）。
迁移成功门、三角色 file secrets、持久卷与资源限制由基础 Compose 保留。

本轮仅本地 Docker 验收；没有连接真实服务器、安装 Dokploy、创建 Tunnel 或申请证书。
Dokploy 实机、真实 ACME 和公网入口验收保留第 7 组，须用户提供并授权测试资源。

## 1. 选择网络和确切代理地址

部署目录权限 0700，`.env` 与渲染文件权限 0600；`.env` 只填写公开配置与 file secret
路径。外部模式加入以下**非敏感**设置，地址只是例子，必须替换为实测地址：

```dotenv
COMPOSE_PROFILES=
EXTERNAL_INGRESS_NETWORK=app-ingress
TRUSTED_PROXY_CIDRS=172.31.90.2/32
APP_URL=https://app.example.com
APP_DOMAIN=app.example.com
```

`app-ingress` 是由该应用入口 owner 管理的既有 Docker 网络。代理与 web 接入这个网络，
代理不接 `<project>_data`。override 将基础 ingress 换为外部网络、移除 web 固定 IP；
Caddy profile 改名并清空 ports，因此 `.env` 误留 `caddy` 也不会启用它。
不要显式启动 `disabled-caddy`。切换前停止本项目已运行的 Caddy，修改 profiles 不会停止
已有容器；仅停止自己的 service，不停止已有代理：

```sh
docker compose --env-file .env -f compose.yaml --profile caddy stop caddy
```

代理应在自己的 Compose 配置中声明这个网络及固定 IP。已有容器的临时接入形式为：

```sh
# 网络已有受控 IPAM；本步骤只在选定并授权的入口上执行。
docker network connect --ip 172.31.90.2 app-ingress <proxy-container>
docker inspect --format '{{json .NetworkSettings.Networks}}' <proxy-container>
```

不把此命令当成容器重建后的持久配置。把固定接线写入代理自己的配置，检查目标地址无
冲突。共享 Dokploy 网络若不能固定 IP，部署/重建后 inspect 实际 peer，再更新 web 的
`TRUSTED_PROXY_CIDRS` 并重建 web；不得为了省去更新而信任整个 Docker 子网。
多代理用逗号列出每个 IPv4 `/32` 或 IPv6 `/128`。其他容器不得共用这些地址。

web 只使用 TCP peer 和经过可信边界的 XFF，从右向左找到第一个非可信地址；不会使用
`CF-Connecting-IP` 或 `Forwarded` 当身份。边缘代理必须覆盖不可信转发头。Traefik 公网
entrypoint 保持 `forwardedHeaders.insecure=false`，没有上游代理时不设置 trustedIPs；
前面还有代理时只列出其确切地址并验证整条链。不要把任意客户端列入 trustedIPs。
依据 [Traefik entrypoints](https://doc.traefik.io/traefik/reference/install-configuration/entrypoints/)。

## 2. Dokploy / Traefik

在用户选择的充足测试主机上采用 **Docker Compose**，不要改成 Stack/Swarm。
Dokploy 是可选运维层；服务器从同 SHA bundle 拉镜像，不构建业务源码。
将基础 Compose 与代理 override 合并，作为 Dokploy 的 Compose 输入（受限文件，不提交）：

```sh
umask 077
docker compose --env-file .env -f compose.yaml -f compose.proxy.yaml config > compose.dokploy.yaml
```

使用该文件的服务拓扑与同一组预构建 image；正确设置部署目录及 secrets/certs 的绝对路径，
不要从面板环境变量传入密码。Domains 只选 **web / 3000 / HTTPS**，其他服务不加域名。
选择已有 Traefik 入口网络为 `EXTERNAL_INGRESS_NETWORK`。域名功能会在运行时增加 labels
和网络，因此必须使用 Preview Compose 查看最终输入。不能照搬示例把全部服务接入
`dokploy-network`。[Dokploy 官方 Domains](https://docs.dokploy.com/docs/core/docker-compose/domains)
描述了自动注入和预览；具体版本的预览结果才是部署依据。

给 web 的 Traefik 配置还需指定网络与端口，避免从 web 的 data 地址选择 upstream：

```yaml
services:
  web:
    labels:
      traefik.enable: 'true'
      traefik.docker.network: ${EXTERNAL_INGRESS_NETWORK}
      traefik.http.services.app-web.loadbalancer.server.port: '3000'
```

若 Domains 已生成不同 service/router 名，使用该实际名字，并将 router 指向它；不要
重复定义冲突 router。TLS resolver、Host rule 与 HTTP→HTTPS 跳转由已有 Traefik/Domains
设置，不额外发布本栈端口。PG/Valkey/jobs/migrate 仍只连接 data。
若所用 Dokploy 隔离模式重写了网络，调整到上述拓扑后再次 Preview；不接受新增 default/
代理网络连接数据服务。面板自动部署不能跳过版本化部署入口的排空、强制 migrate 与
health/SHA 验证；不要用直接 `up` 替代升级流程。

## 3. 既有代理与 cloudflared

既有 Nginx/Caddy/Traefik 的 upstream 为 `http://web:3000`，只接 ingress，使用已有公网
TLS listener。新栈不发布 3000/3001/5432/6379，也不接管宿主 80/443。覆盖 XFF 为实际
客户端地址，并移除不可信 `Forwarded` / `CF-Connecting-IP`；Caddy 可复用基础 Caddyfile
中的三条 `header_up`，Traefik 使用上述 entrypoint 信任边界。

cloudflared 也只接 ingress，Tunnel 的 public hostname 使用 `http://web:3000`，公开
HTTPS 在 Cloudflare 边缘终止，容器到 web 是同机私有 HTTP；不要将这描述成 origin TLS。
隧道 token/credentials 文件只读分配给 cloudflared，web/jobs 不获得。保留已有公网代理
端口，不为隧道添加宿主 ports。优先接到已有、已验证的边缘代理，让它按已验证客户端链
重建 XFF，再信任它在 web 网络上的确切地址。

本节描述接入**已存在的**、由入口 owner 自行运维的 cloudflared。需要随发布交付、固定
digest 且受 `deploy.sh` 管理的隧道入口时，使用第 4 节的 `compose.tunnel.yaml`。

直接 cloudflared→web 时，只有在真实 Tunnel 验证 Cloudflare edge 对恶意 XFF 的清洗、
实际 socket peer 和最终 client IP 后才能启用该 `/32` 或 `/128`。验证之前设
`TRUSTED_PROXY_CIDRS=`（本 override 会拒绝空值，可先使用基础 Compose 的 ingress 手动
接线），代价是全部流量按隧道 peer 计防刷，不允许先信任整个子网。真实 Tunnel 未在本轮
验收。若使用 HTTPS origin，应由已存在的 TLS 代理处理并保持 `noTLSVerify=false`，配置
`originServerName` 和 `caPool` 验证私有 CA；参考
[Cloudflare origin parameters](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/configure-tunnels/origin-parameters/)。

Cloudflare 边缘（橙云代理与 Tunnel 相同）在源站开始响应前或两段数据之间约 100 秒无字节时
返回 524，Free/Pro/Business 不可调整。AI 对话流与 OpenAI 兼容流在上游静默（如推理模型隐藏
思考）满 25 秒时发送心跳（站内为前端忽略的 transient 片段，公开 API 为 SSE 注释
`: keepalive`），并在等待首个 token 前发出响应头，见 [06-ai §3「空闲心跳」](../06-ai.md)。
中间若还有 Nginx 等代理，其读超时须大于 25 秒且不得缓冲 `text/event-stream`
（Nginx 对这些路由设 `proxy_buffering off`）；Caddy 对 SSE 默认立即转发。

## 4. 随发布交付的 Cloudflare Tunnel（compose.tunnel.yaml）

适用于 DNS 由 Cloudflare 管理、希望不开放服务器 80/443、不暴露源站 IP 的部署。拓扑：

```
用户 ──HTTPS──> Cloudflare 边缘 ──Tunnel(出站 QUIC/HTTP2)──> cloudflared ──HTTP──> web:3000
```

- cloudflared 镜像来自同 SHA image-set（catalog 第 9 个服务），基于官方
  `cloudflare/cloudflared:2026.10.0` 的固定 multiarch digest，不重新编译，非 root UID 65532。
- 叠加文件启用 `cloudflared`、停用内置 Caddy 并清空 ports；任何服务都不发布宿主端口。
- cloudflared 只接 ingress，固定地址 `172.30.77.6`（避开 Caddy `.2`、web `.3`、object-storage
  模式 jobs `.4`）；不接 data。web 的 `TRUSTED_PROXY_CIDRS` 由叠加文件固定为 `172.30.77.6/32`，
  `.env` 中的值在隧道模式下不生效。
- 只读根文件系统、`cap_drop: [ALL]`、`no-new-privileges`、`restart: unless-stopped`、日志轮转与
  其他常驻服务一致；`--no-autoupdate`，关闭 management diagnostics；metrics/ready 只监听容器回环，
  healthcheck 使用镜像自带的 `cloudflared tunnel ready`。
- 与 `compose.proxy.yaml` 互斥：`deploy.py` 在导入 bundle、拉取或任何服务变更前拒绝同时加载。
  也不与 `compose.object-storage.yaml` 组合（其 S3 域名依赖内置 Caddy 发布 443，部署门会因 Caddy /
  宿主端口拒绝）；隧道模式的对象存储使用 `compose.s3.yaml` 外部 S3 / R2。
- Cloudflare 边缘对单个请求约 100 秒超时，长时间同步请求可能被切断（与橙云代理相同）。

### 4.1 在 Cloudflare 创建 remotely-managed Tunnel

1. Cloudflare Zero Trust → Networks → Tunnels → Create a tunnel，类型选 **Cloudflared**，
   命名（例如 `product-res-production`）。
2. 安装步骤页只复制 connector **token**（`cloudflared tunnel run --token <token>` 中的值）。不要在
   服务器上执行页面给出的安装命令，也不要把 token 粘贴到 shell 历史、工单或聊天中。
3. Public Hostname（新版控制台为 Routes → Published application）：主机名选 `APP_DOMAIN`
   （例如 `product.ezarouter.cc`），Path 留空，Service 类型 **HTTP**，URL 填 `web:3000`。
   控制台会自动创建 proxied CNAME 到 `<tunnel-id>.cfargotunnel.com`；若该主机名已有
   A/AAAA/CNAME 记录，需先删除旧记录（切换窗口内站点不可达，选择低峰时段）。
4. 不配置 Access 策略，不启用 `noTLSVerify`：origin 是同机私有 HTTP，不是 origin TLS。

### 4.2 写入 token secret

token 只作为 file secret 挂给 cloudflared，经 `--token-file` 读取，不进入 `.env`、环境变量、
命令行、日志、bundle 或版本库。在部署目录（`SECRETS_DIR` 父目录 0700）中以有权设置属主的账号执行，
从剪贴板或密码管理器经 stdin 写入，不出现在 argv：

```sh
umask 077
install -m 0600 -o 65532 -g 65532 /dev/null secrets/cloudflared_tunnel_token
# 粘贴 token 后按 Ctrl-D；文件只有一行，结尾可有一个 LF。
cat > secrets/cloudflared_tunnel_token
stat -c '%a %u:%g %s' secrets/cloudflared_tunnel_token   # 期望 600 65532:65532 及非零大小
```

隧道模式下 `deploy.py` 要求该文件为非空普通文件、group/other 无权限，且只挂给 cloudflared；
缺失或权限过宽时在任何服务变更前失败。轮换：在 Cloudflare 的 Tunnel 页刷新 token，替换此文件后
重新执行部署命令。

### 4.3 部署命令

首次使用隧道的发布必须包含 cloudflared 镜像（协调者以 `new_services=cloudflared` 发布新 SHA）。
旧 bundle 不含 `compose.tunnel.yaml`，不能现场添加。`deploy.sh` 始终以 bundle 的 `images.env`
digest 固定 `CLOUDFLARED_IMAGE`。

```sh
deploy.sh --host <user@host> --dir /srv/product-res --sha <full-sha> \
  --bundle <bundle-dir> --compose-file compose.tunnel.yaml
# 同时使用外部 S3：--compose-file compose.s3.yaml --compose-file compose.tunnel.yaml
```

部署流程不变：拉取 → 排空旧 web/jobs → 迁移 → 启动 web/jobs 与 cloudflared。随后按 project /
service 标签停止并移除**当前计划未启用**的入口容器（从 Caddy 切到隧道时移除旧 Caddy 并释放
80/443；回滚到 Caddy 计划时移除 cloudflared），再执行公网健康门。健康门经 `APP_URL` 的
`/api/health` 检查完整 SHA，请求经 Tunnel 到达 web，因此同时证明隧道连通；jobs 的内部 ready
检查不变。隧道未连通时部署失败并输出回滚命令；回滚到上一个成功计划会重新启动其 Caddy。
主机防火墙 / 安全组关闭 80/443 入站属于主机层操作，在确认隧道稳定后另行执行。

### 4.4 真实环境验收（部署阶段）

CI 只验证镜像构建、版本、非 root、无 token 拒绝启动，以及 Compose 渲染与部署门；以下项必须在
真实 Tunnel 上完成并记录：

1. 公网 HTTPS：`curl -sS https://<APP_DOMAIN>/api/health` 返回 200 与目标完整 SHA，证书由
   Cloudflare 边缘提供；cloudflared 为 healthy，其日志只出现 tunnel ID / connector ID，不出现 token。
2. 无宿主监听：服务器上 `ss -ltnp '( sport = :80 or sport = :443 )'` 为空，本 project 的
   `docker ps --format '{{.Names}} {{.Ports}}'` 无宿主端口映射。
3. 客户端 IP：从已知出口 IP 的机器访问会记录客户端地址的入口（如登录或限流相关请求），在应用
   结构化日志或审计记录中确认 clientIp 等于该出口 IP，而不是 `172.30.77.6` 或 Cloudflare 边缘地址。
4. 伪造 XFF：同一机器发送 `curl -H 'X-Forwarded-For: 203.0.113.9' https://<APP_DOMAIN>/...`，确认
   记录的 clientIp 仍为真实出口 IP。Cloudflare 把边缘看到的来源追加在 XFF 末尾，web 从右向左跳过
   可信的 `172.30.77.6` 后取到的就是它；若结果为伪造值或边缘地址，立即回滚到 Caddy 计划并停止验收。
5. 运行身份：`docker top <cloudflared-container> -o pid,uid` 为 65532，`docker inspect` 显示
   ReadonlyRootfs=true、CapDrop=[ALL]、只接 `<project>_ingress` 且地址为 `172.30.77.6`。

## 5. 权限与最终配置门

Docker Compose file secrets 为宿主 bind mount，不会替宿主改 UID/mode。受限父目录0700，
按接收容器 UID 设置只读权限：PG/Valkey999，web/jobs/migrate1000，Caddy10001；共享
file secret 使用适当的受限组或 ACL，让两个指定 UID 可读，不扩大到宿主公共目录。
PG 私钥只给PG，应用只拿 CA；超级用户/migrator/readonly/backup凭据不分配给web/jobs，
代理只持有自身TLS材料，Tunnel token 只给 cloudflared（UID65532，0600）。代理 Docker socket 和 Dokploy 控制权限相当于宿主管理权限，
不能挂给应用或隧道；Traefik已有provider权限不因本接入扩大。日志不记录请求query、
认证链接或secret。网络隔离不替代宿主/面板访问权限。

用最终输入再次渲染 JSON，验证而不打印环境变量或 file secret 路径：

```sh
umask 077
docker compose --env-file .env -f compose.yaml -f compose.proxy.yaml config --format json > final.json
node test-proxy.mjs --external-config final.json
```

Dokploy Preview 导出为 `compose.preview.yaml` 后，在它实际使用的目录、同一环境渲染：

```sh
docker compose --env-file .env -f compose.preview.yaml config --format json > final.preview.json
node test-proxy.mjs --external-config final.preview.json
```

隧道模式渲染时加 `-f compose.tunnel.yaml`，并用 `node test-proxy.mjs --tunnel-config final.json`
检查：额外要求 cloudflared 只接 ingress 固定地址、web 只信任该 `/32`、token 只经 file secret
挂给 cloudflared、只读根文件系统且不存在 Caddy。

门要求 image-only、所有 service显式非root UID、web仅data+ingress、数据服务仅data、
迁移成功依赖、应用secret不越权、确切可信IP以及零宿主ports。这不能证明已部署容器；
运行后仍 inspect 实际网络/端口/UID，公开HTTPS请求须正常校验证书，发伪造XFF再核对
防刷身份；最后检查 `/api/health` 完整SHA与jobs readiness。不要用config通过冒充实机验收。

## 本地证据

从仓库根运行
`SELFHOST_PROXY_CADDY_IMAGE=<release-caddy-image> node deploy/selfhost/test-proxy.mjs`。
必须使用已构建的非root Caddy wrapper（生产Dockerfile已移除低端口file capability），
不使用带file capability的上游镜像代替。脚本生成随机隔离project，执行plain、
external及误启全部profiles的真实Compose渲染，并证明宽泛trusted CIDR和PG宿主端口
会被检查门拒绝。夹具无宿主ports：Caddy2.11.2在8443终止临时证书TLS、Node22.23.3
回显上游请求，恶意XFF被实际client peer覆盖，CF/Forwarded被删除；未知CA失败。
运行UID为web/probe1000、proxy10001，proxy/probe不接data。finally仅清理自己的资源。
这是已有代理模式机制验证，不是Dokploy/Traefik或真实Tunnel认证链验收。

真实应用的请求metadata边界复用
`pnpm --filter @product-res/platform exec vitest run test/node/request.test.ts`，覆盖未可信peer、
右侧链、mapped IPv6和非法XFF。全栈实际TLS/UID已有
[A最终Compose证据](selfhost-a-final.md#最终-compose-证据2026-10-13-本地--2026-10-12-utc)：
SHA `0c11b8787b211323a309c377d50e4fdbafc90816`，PG/Valkey999，web/jobs1000，Caddy10001，
verify-full与HTTPS通过；本轮引用该明确历史证据，不重新宣称整栈运行或新的SHA验收。
