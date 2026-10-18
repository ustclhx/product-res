# 2026-10-16 真实服务器验收预检

后续已使用正式 `aaf8299` 包执行准备和部署尝试；新阻塞、DNS/R2/停服及主机保留状态见
[部署尝试记录](attempt-aaf8299.md)与[结构化证据](attempt-aaf8299.json)。下文为先前预检快照。

本次完成用户指定 R2 范围的规划更新及只读预检，尚未部署，没有新增任何验收通过项。
[结构化证据](preflight.json)不含连接串、凭据、邮箱、宿主身份或业务数据。服务器只执行了
OS/CPU/内存/磁盘、Docker/Compose、服务自启、容器与监听、目标目录存在性的只读查询。

## 用户决定

- 复用 `product-res-ecs`，域名 `selfhost.ezarouter.cc`、模板 Caddy，保留既有 Docker/系统配置。
- storage-observability 1.7 仅验 R2。delivery 7.2 使用同 R2 账号下独立主/副本桶及独立受限
  token；明确失去供应商独立性，不证明账号级故障容灾。通用 S3/跨供应商能力仍保留。
- 已追加授权记录原重启策略后停止 sub2api-deploy/new-api 组、openclaw 与 warp-svc，
  只停止不删除；本 worker 尚未执行，避免发布配置未就绪时造成无效停机。
- 7.3 真正整机 reboot 已追加获准，先完成部署、ACME、6.4、7.2；留存重启前状态并验证
  §6.8，非 selfhost 已停止服务不得自动恢复。尚未执行 reboot。

## 发布配置阻塞

可信发布 [run 38624392597](https://github.com/ustclhx/product-res/actions/runs/38624392597)
成功，完整 SHA 为 `598d1f68b6ef7b19e8a6d30c13575bac1701b7c2`。下载同 run 的 image-set
和 release artifact；包内 verify 与干净 example Compose config 都通过，八服务/双架构、
fixture=false。未触发 publish、未拉业务镜像到服务器、未修改旧 bundle。

对该实际下载 bundle 的渲染配置核对：web/jobs 均无 `S3_*` environment，且无应用 S3
secret 挂载。基础 Compose 加 `.env` 中的 S3 参数并不会将其传入应用。唯一存储 override
是 `compose.object-storage.yaml`，要求本地 SeaweedFS/object-storage-init，签名端点固定由
`S3_PUBLIC_DOMAIN` 拼接；它不构成本次关闭自带 profile 的 R2 外部路径。

可复核的同 SHA 材料：

| 文件/位置 | 事实 |
| --- | --- |
| `compose.yaml:16`（x-app-env）、`:33`（x-app-secrets） | 未声明 S3 环境变量/应用凭据 |
| `compose.object-storage.yaml:9`、`:51`、`:80`、`:92` | S3 装配与自带存储初始化器耦合 |
| `deploy.py:64` | 追加 Compose 必须属于校验 bundle，拒绝任意本机 override |
| `release/bundle.py:30` | 正式运行白名单没有独立外部 S3 配置文件 |

仓库 [deploy-selfhost 技能](../../../../../.agents/skills/deploy-selfhost/SKILL.md) §3.2 要求：
“需要这些集成时停在配置缺口，交发布负责人在项目源码完成显式env/secret装配、必要的受审白名单扩展与验证，发布新SHA集合/bundle后再继续”。
因此本 worker 不现场改 checksum/白名单，不将未提交补丁挂入旧镜像，不直接 up 绕过发布门。
应由协调者安排发布负责人补齐外部 S3 env/file secrets 的正式运行材料、白名单及配置验证，
发布新的受信同 SHA image-set/bundle 后继续本次 R2/服务器验收。

## 主机预检的实际范围

Ubuntu 22.04.5 x86_64，2 vCPU，物理内存 3495 MiB，采样 available 1230 MiB、swap
used 315 MiB；磁盘约 14 GiB 可用。现有 Docker 29.6.2、Compose 5.3.1，Docker 自启。
80/443 无监听，计划 `/opt/product-res-selfhost` 尚不存在。此为共用服务器，不能运行空白 init，
不会重装/降级 Docker 或改防火墙/SSH。采样发生于现有服务停止前，不能用作 6.4 整机预算。
追加停服授权已解除资源隔离的权限门；是否达标仍需真实运行测量，未推定通过或失败。

## 本地验证

| 检查 | 结果 |
| --- | --- |
| 两个修改 change 的 OpenSpec strict validate | 通过 |
| 正式 artifact 包内 verify / compose-config | 通过 |
| Node 22 下 `pnpm check` | 通过（含现有工程脚本 16 项） |
| Node 22 下 `pnpm typecheck` | 14/14 通过，均复用缓存；只有规划/证据文档变化 |
| release bundle 现有 Python 测试 | 7/7 通过 |
| `git diff --check` | 通过 |

未新增测试、未执行全量 `pnpm test` 或 build：本次没有运行代码变更，使用用户要求的
check/typecheck 与直接相关 bundle 测试。所有运行验收仍未完成，不以历史本地证据代验。

## 未完成矩阵

| change | 编号 | 本次状态 |
| --- | --- | --- |
| storage-observability | 1.7 | R2 范围已更新；真实 R2/业务/copier 验收待办 |
| delivery | 7.1 | 正式发布来源已核实；部署未执行，外部 S3 装配阻塞 |
| foundation | 7.4 | 公网 ACME 签发/续期待办 |
| job-engine | 6.4 | 停服授权已取得；双 jobs/长任务/整机预算待办 |
| delivery | 7.2 | 独立桶/token 范围已更新；备份/副本/临时 PITR 待办 |
| delivery | 7.3 | reboot 已获准；须先完成前置验收，尚未执行 |
| foundation / delivery | 9.4 / 7.4 | 等待完整证据后汇总，保持未勾选 |

没有创建 DNS、R2 桶或 token，没有主机写入、停服或 reboot；生产 Cloudflare/staging 未触碰。
不归档、不同步主 specs、不合并 PR。当前 Orca 无绑定 orchestration run，不伪造 worker_done
生命周期消息，使用卡片报告阻塞。
