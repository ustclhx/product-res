# 显式部署、health 与兼容回滚（D 2.1–2.3）

服务器只消费可信同 SHA release bundle 和预构建镜像，不需要 Node/pnpm、Git或业务源码。
支持普通 Compose 与同一 Compose 的外部代理 override。入口不内置 SSH alias，不连接
现有服务器、不触发 GHCR 发布；本轮验证仅使用本地隔离 Docker/HTTP/VM。

## 准备

确认成功发布 run、完整 SHA、namespace、八服务 digest / revision / 双架构，并从受信
Actions artifact 取得同 SHA bundle。核对来源后解压到独立目录，运行：

```sh
python3 <bundle-dir>/release/bundle.py verify <bundle-dir> --sha <full-sha>
```

checksum提供传输完整性，不能认证未知来源。打包规则见 [release](selfhost-release.md)。
服务器需要 Python3、Docker/Compose2.40.3、curl；Docker socket权限等同主机管理权限。
空白主机可先按 [初始化](selfhost-init.md) 执行；共用主机只能使用获准的既有环境。

部署目录显式提供，0700；`.env`0600，只填写非敏感域名/集成ID和file secret路径。
PG/Valkey/认证 secret按 `secrets.example` 创建并独立保管，PG CA/SAN与HTTPS证书验证
必须成功。原始外部命令输出只保存于内部管道，不打印Compose config、URL或驱动错误。
至少保留部署目录2GiB空闲，还需按实际Docker data-root、PG/WAL/备份增长审查磁盘余量。

## 部署顺序与状态

```sh
<bundle-dir>/deploy.sh --local --dir /srv/product-res-selfhost \
  --sha <full-sha> --bundle <bundle-dir>
# 或从操作员电脑；已有受信known_hosts/非交互SSH身份，无明文密码参数：
<bundle-dir>/deploy.sh --host <explicit-user@host> --dir /srv/product-res-selfhost \
  --sha <full-sha> --bundle <local-bundle-dir>
```

SSH使用 `BatchMode=yes`、`StrictHostKeyChecking=yes`；上传独立临时目录、遥端执行本机
入口，finally仅删除自己创建的临时上传目录。目标路径是绝对路径，入口不会忽略host key
或默认选服务器。ssh身份由操作者的受限配置提供。

本机入口在 `release-state/deploy.lock` 上持有文件锁直至完成：

1. 校验bundle exact file/checksum、SHA/digest、配置和非root/端口边界，导入不可覆写的
   `releases/<sha>`；相同SHA的不同材料拒绝。
2. `docker compose pull` 拉取所有启用服务；核对每镜像OCI revision为目标完整SHA。
   不拉/启未开启profile；外部模式禁止显式disabled-caddy或通配profile。
   拉取失败不会停止旧应用或改变成功记录。
3. 用旧记录的Compose计划/公开配置停止web/jobs，最长45秒；inspect确认全部退出。
   被SIGKILL的ExitCode137拒绝继续，需要调查shutdown/ownership，不能删除owner绕过。
4. 记录尝试版本，启动/等待PG与Valkey。迁移前持久记录 `schemaSha`；即使失败也不能假设
   数据库未改变。强制新建目标migrate，一次运行业务SQL→DBOS迁移，非零退出阻止目标app。
   若启用自带对象服务，随后等待object-storage并强制重跑bucket init，成功才启动app。
5. `up -d` web/jobs与启用的代理/backup，默认360秒检查公开`/api/health`和jobs内部readiness。
   成功后才更新 `successful`/`previous`；失败保持前成功记录，保留失败bundle和诊断。

`release-state/state.json`记录成功/上一成功/尝试计划、最后迁移SHA与公开配置快照；镜像
始终来自bundle清单，`.env`或进程里的IMAGE值不能替换digest。rollback使用旧公开配置和
现有受限secret文件，不保存/恢复secret内容。project名不能改，避免意外换持久卷。
已有未托管stack拒绝自动接管，需协调者核实真实bundle/成功版本/卷后制定导入方案。

开启backup加 `--compose-file compose.backup.yaml --env-file .env.backup`；开启自带对象
服务加 `--compose-file compose.object-storage.yaml --env-file .env.object-storage`（其中
`COMPOSE_PROFILES=object-storage`）。外部代理加 `--compose-file compose.proxy.yaml`，详见
[代理接入](selfhost-proxy.md)；附加env均0600，附加Compose必须属于校验后的bundle。

## 有界 health 门

health成功必须HTTP200、status=ok、完整目标SHA、db/cache/queue/scheduler全部up、有效
成功heartbeat且不超过10分钟；jobs `/internal/ready`独立满足同样条件及同SHA。公开请求
使用curl默认TLS验证、不跟随redirect、8秒内的连接/请求时限、最多64KiB响应；jobs通过
容器内Node短时fetch，整体受剩余deadline约束。半开响应、无效JSON、503、旧web或jobs
SHA均失败。日志仅输出event、target/web/jobs允许的完整SHA，不输出响应正文或URL。

默认等待360秒覆盖首次五分钟heartbeat，不回填数据库伪造心跳。
`--health-timeout <seconds>`可设置1–900，短窗口只用于已有心跳/隔离故障测试。
连接失败会继续有界轮询，失败非零退出并提示上一成功SHA回滚命令与兼容条件。
app健康不能代表backup成功；backup另查真实base/dump/WAL链状态。

## 回滚与失败恢复

```sh
<bundle-dir>/deploy.sh --local --dir /srv/product-res-selfhost --rollback <recorded-success-sha>
# SSH模式换为 --host <explicit-host>
```

只接受记录的当前/上一成功bundle，拉取其digest、保留全部卷、重启并核对公开/jobs SHA。
最后一次迁移的release必须在 `rollbackCompatibleWith` 显式包含目标SHA；它是在审阅schema
向后兼容、DBOS handler/checkpoint、长任务已排空或仍由匹配版本处理后形成的声明。
健康失败的迁移release也参与这个门。应用回滚不改变schemaSha，不执行旧migration或
任何down migration、不修改DBOS内部表、不删除卷或ownership。

未声明或不兼容时入口在pull/stop之前拒绝：取匹配PG17/应用版本和目标UTC点的备份，
恢复到**新空卷**，默认不启动jobs或外部副作用，校验业务/角色/引擎状态后显式promote、
重建正确secret/TLS/ownership环境，再决定入口切换。对象文件/支付/邮件等外部副作用
不会随PG回退。restore/drill已交付，见[恢复runbook](selfhost-restore.md)；旧版部署bundle不含恢复器，
必须另取匹配材料。异机ownership仍待B签收，交协调者确认切流量，不对原卷降级。

## 证据与限制

`python3 -m unittest discover -s deploy/selfhost -p 'test_deploy.py'`覆盖重要发布失败门
及本地HTTP旧SHA/503/半开响应/脱敏；`python3 deploy/selfhost/test-deploy-compose.py`
使用真实本机registry digest和隔离Compose，验证初始/升级、pull/迁移/health失败、兼容
回滚、持久marker及并发文件锁。轻量Node镜像只证明编排顺序和卷保留，不证明PG迁移/
DBOS checkpoint/ownership恢复或真实五分钟slot。正式业务镜像的空卷部署、升级和回滚另由`test-release-compose.py`验收；它使用成功发布
bundle与registry镜像，第二版仅为本地registry版本元数据fixture。保留真实已完成DBOS
状态不等于未完成任务恢复；后者及6.3仍依赖1.5签收，2.1/2.3仅按已完成证据判断。

第二次真实GHCR发布已授权并成功，完整恢复bundle已齐，见[release](selfhost-release.md#第二次正式-ghcr-集合与完整-bundle2026-10-14)。
第二次发布时2.1/2.3仍依赖B/D1.5签收，第7组主机/入口/备份/重启均BLOCKED；
没有连接 `product-res-ecs` 或其他真实服务器，不手动部署Cloudflare staging。

2026-10-15 的 [d-vm验收](evidence/selfhost/d-vm-2026-10-15/report.md)补充临时Debian VM、
真实SSH入口、完整backup和宿主reboot证据，并发现固定正式`0813050`的B退出证明缺口。
本PR补修同机身份/namespace及guard；旧记录与异机迁移、新正式镜像仍待签收，
不以本地新源码fixture提前勾选1.5或依赖它的2.1/2.3/6.3。

2026-10-15 的第三次正式发布 `598d1f68b6ef7b19e8a6d30c13575bac1701b7c2` 已在
新Lima `selfhost-d-vm2` 完成正式flock生命周期、全栈实际reboot、严格SSH部署与真实
PG/DBOS升级/失败/兼容回滚，1.5/2.1/2.3/6.3已勾选。
详见[d-vm2证据](evidence/selfhost/d-vm2-2026-10-15/report.md)；升级回滚第二版明确为
本地registry仅SHA元数据fixture，不是第二个正式版本或补修源码镜像。
修复前镜像从未部署真实服务器，不提供旧缺machineId/token锁记录的迁移，要求新卷
部署；异机退出证明仍开放，第7组不变。VM及所属资源已清理。
