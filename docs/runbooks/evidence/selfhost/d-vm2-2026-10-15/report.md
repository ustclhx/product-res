# D 正式 flock 镜像临时 VM 验收（2026-10-15）

本轮只创建本机 Lima `selfhost-d-vm2`：Debian12 arm64、2 CPU、4 GiB、24 GiB。
输入为用户已批准的第三次正式发布
[`38624392597`](https://github.com/ustclhx/product-res/actions/runs/38624392597)，
完整 SHA `598d1f68b6ef7b19e8a6d30c13575bac1701b7c2`，namespace
`ghcr.io/ustclhx/product-res`。未触发新发布、覆写 tag、连接真实服务器或手工部署 CF staging。

## 来源与隔离

`provenance.json` 记录成功 run、artifact tar 摘要和八服务正式 digest；直接解压原始
Actions tar，包内原版 verify 与干净目录 compose-config 均通过，匿名 pull 后逐镜像
OCI revision 为目标 SHA。正式 bundle 保持不可变，部署无需业务源码、Node/pnpm或Git。
Git 仅在正式初部署/reboot通过后为本地版本元数据测试夹具安装。

`official-jobs-isolation.json` 记录正式 jobs inspect：独立 PID namespace、无业务源码
挂载、持久 ownership 卷、只读真实宿主 machine-id。`harness-provenance.json` 记录
测试输入摘要。受控任务使用同 SHA **正式 migrate 镜像内的引擎源码和固定依赖**，只挂载
`vm-lifecycle.mts` 测试 handler；没有挂载 job-owner/job-engine/job-guard 补修文件。
备份 S3/TLS 服务只在 VM 私网中运行，测试 helper 明确标记为夹具，不暴露数据端口。

## 验收对应

| 编号 | 本轮证据 | 验证结果 |
| --- | --- | --- |
| 1.5 | `official-lifecycle.json`、`official-jobs-isolation.json` | 正式 flock 的 exit/namespace/recreate/reboot 全阶段通过；旧进程仍活且 DB advisory 已释放时拒绝同 ID，真实退出后恢复，原任务/deadline和成功 step保持 |
| 6.3 | `init.json`、`ports.json`、`runtime.json` 的 prepare/after-reboot | init幂等与拒绝、外部22/80/443、开机自启、真实reboot后含backup全部常驻服务恢复、迁移不循环、fresh自然heartbeat及完整SHA通过 |
| 2.1 | `runtime.json` 的 ssh/gates、`mechanism.json` | 正式bundle严格SSH传输部署、真实升级/迁移失败门；隔离机制验证pull失败保护与发布并发串行 |
| 2.3 | `runtime.json` 的 gates、`mechanism.json` | 兼容双版本更新→迁移/health失败→正式SHA回滚；数据/引擎状态/卷保持，不跑旧迁移；不兼容在变更前拒绝并指向新卷备份恢复 |

`official-lifecycle.json` 的 `acceptancePassed=true`，且
`engineMode=official-flock`、`sourcePatchUsed=false`、`hostPidUsed=false`。
旧进程 close 后仍存活，SQL显式验证DB advisory可取得；重复进程必须以
`JOB_ENGINE_EXECUTOR_IN_USE` 拒绝，而非任何非零退出都算通过。SIGKILL 后先 inspect
确认真实退出，再重用相同ID和原ownership卷。recreate/reboot完成任务的prepared与completed
callback均恰一次，原wait deadline不变。没有改写owner JSON、删除owner目录或用TTL放行。
报告的前七条checks依次对应prepare、after-reboot、recreate、exit的拒绝/真实退出恢复、
namespace的拒绝/真实退出恢复；后两组同名检查分别来自exit与namespace独立命令，最后一条为cleanup。

`runtime.json` 的 `notVerified` 是该全栈脚本自己的范围；其中 unfinished task replay
由独立 `official-lifecycle.json` 补足，cross-host recovery本轮仍未验收。
实际reboot改变boot ID；未执行up/restart修补常驻服务。PG/Valkey/web/jobs/Caddy/backup
及测试存储、任务probe自动恢复；migrate的容器ID、finishedAt、restartCount不变且exit0。
等待新的五分钟UTC成功slot，而非回填heartbeat。备份要求base/dump/WAL verification和成功
schedule slot、健康及scheduler内核锁，reboot前后成功slot和backup ID保持，不能由进程存活代签。

SSH在这台临时VM内通过显式测试host（127.0.0.1）传输并远程执行正式bundle，使用
BatchMode和真实host key校验，保留卷、目标完整SHA正确，`.incoming-*`已清理。
此为真实SSH协议/部署入口证据，不是连接远程生产服务器。

回滚第二版仅为**VM内本地registry版本元数据夹具**：ENV/OCI revision、`/version`和
编译产物中的完整SHA字面量变化；`fixtureMetadataDiff`验证字节替换可逆，业务/schema/
handler不变，全部旧受控任务已完成。夹具显式声明兼容正式SHA，不修改正式GHCR镜像或bundle。
app角色替换migrator secret造成真实权限失败，目标app被阻止；故意使用不信任的CA造成
真实HTTPS readiness失败，成功记录保留；回滚后完整SHA、真实PG/DBOS/任务记录与卷保持。
`mechanism.json` 的合成Node/marker夹具只证明编排门，不能代替上述正式业务/生命周期证据。

## 可重跑命令

仅在独占临时VM内，将测试脚本和公开helper置于持久 `/opt` 路径，handler/helper对容器UID
可读；secret单文件仍0600且匹配指定UID。bundle必须从受信artifact原始tar直接解压。

```sh
sudo bash /opt/d-vm2-release/init-server.sh --dir /srv/d-vm2-init
sudo python3 -B /opt/d-vm2-harness-input/test-vm.py --phase prepare \
  --directory /opt/selfhost-d-vm2-formal --bundle /opt/d-vm2-release \
  --evidence /opt/d-vm2-results/runtime.json
sudo python3 -B /opt/d-vm2-harness-input/test-vm-lifecycle.py --phase prepare \
  --official-flock --expected-sha 598d1f68b6ef7b19e8a6d30c13575bac1701b7c2 \
  --directory /opt/selfhost-d-vm2-formal --bundle /opt/d-vm2-release \
  --runtime-evidence /opt/d-vm2-results/runtime.json
sudo systemctl reboot
```

重连后先运行lifecycle的after-reboot，再运行全栈after-reboot；lifecycle继续recreate、exit、
namespace；全栈继续ssh、gates。各命令保留对应prepare的全部路径/SHA参数，最后分别cleanup。
`test-deploy-compose.py`在独立目录使用同正式bundle部署入口代码，以本地fixture模式验证八项机制。

## 过程异常及修正

- `initial-transfer-rejection.json`：首次macOS重新tar混入Apple元数据，exact-file校验在pull/部署前拒绝；改用原始Actions tar直接传输，未改发布材料。一次诊断import产生的本地`__pycache__`也被定向移除，包内verify再次通过。
- `helper-permission-correction.json`：TLS测试helper保留宿主0600/UID501而触发EACCES；只将非秘密测试helper在VM设为0644，重启测试TLS夹具。此修正在正式部署与reboot基线之前，secret仍0600。
- `mechanism-first-failure.json`：空白VM无Git，元数据夹具在创建版本时中止并清理；为夹具安装Git后重跑。
- `mechanism-state-read-failure.json`：一次机制初始snapshot的docker run失败。原版完整诊断重跑八项通过；检查发现PG夹具探针无条件exit0，未证明marker已写。将夹具health收紧为marker存在后，完整机制再次验证；未弱化断言或改正式发布门。

## 升级与未完成边界

协调者已确认修复前镜像（0813050及更早）从未部署到真实服务器。**BREAKING：不提供缺少
machineId/token锁文件的旧owner迁移路径，正式flock版要求新卷部署**；不自动改写旧记录或
删目录绕过。异机恢复退出证明继续作为开放设计项，数据库恢复不代表可启动jobs。

1.5按本轮确定的本机生命周期范围签收。6.2、第7组、异机恢复、真实不同供应商账号、公网
IPv6、ACME/真实服务器与生产容量不由此次轻量2C/4GiB VM验收代签；不勾选A/B/C任务。

## 检查与清理

`root-checks.json`记录根check/deps/singletons/dedupe/typecheck/test/build及部署10项、init8项、
bundle7项Python用例和两change strict validate；所有命令exit0。typecheck/test使用正常Turbo缓存，
platform有两个开发锁用例跳过；真实Linux退出/namespace由VM证据验证。
`rebased-checks.json`记录rebase到main `a3e8179` 后12项完整检查全部exit0；验证后仅补检查证据/文档，harness源码未变。清理只针对本任务资源，结果见`cleanup.json`；
脱敏证据与本worktree保留供PR审阅。

清理已完成：VM内剩余容器/卷/所属网络均0，私有harness已删除；随后停止并删除Lima VM，
列表无该实例、磁盘目录不存在，宿主下载的artifact输入也已删除。
