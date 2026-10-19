# 任务

## 1. 镜像
- [x] 1.1 新增 `deploy/selfhost/cloudflared.Dockerfile`（固定版本与 multiarch digest、OCI label）并加入 `images/catalog.json`
- [x] 1.2 `images/smoke.mjs`（及相关 policy/build 校验）覆盖 cloudflared：版本、非 root UID、无 token 拒绝启动

## 2. Compose 与发布材料
- [x] 2.1 新增 `compose.tunnel.yaml`（cloudflared、停用 Caddy、ingress 固定地址、web 可信 CIDR、secret 挂载、加固项）
- [x] 2.2 `release/bundle.py` 与 `deploy.py` 纳入叠加文件，与 `compose.proxy.yaml` 互斥；补充对应测试
- [x] 2.3 `.env.example`、`secrets.example`、`deploy/selfhost/README.md`、`docs/runbooks/selfhost-proxy.md` 更新

## 3. 发布与部署（协调者）
- [ ] 3.1 合并后 main CI 通过，发布新 SHA（`new_services=cloudflared`）
- [ ] 3.2 用户在 Cloudflare 创建 Tunnel 与 public hostname，token 写入服务器 secret
- [ ] 3.3 部署并完成真实验收：公网 HTTPS、客户端 IP、伪造 XFF、无宿主 80/443 监听
