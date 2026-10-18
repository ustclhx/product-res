# D 临时 VM 与 B 生命周期验收（2026-10-15）

唯一主机为本次新建的 Lima `selfhost-d-vm`：Debian 12 arm64、2 CPU、4 GiB、24 GiB。
没有连接真实服务器，没有触发镜像发布或修改正式 tag，没有手动部署共享 CF staging。
正式输入为 #195 签收的 SHA `081305013b022f457c561eecf5828b1959e13908`，从其 Git 对象和成功
image-set 重建 bundle，八镜像匿名拉取、digest/revision 校验通过。原 bundle 不掺入补修。

## 初始化与端口

`init.json`：单命令安装、重复验证、已用主机与冲突端口拒绝、配置和非敏感 sentinel
保持、Docker/防火墙开机启用。Lima 的两个空 DNS NAT 跳转触发首次预检拒绝；只在本任务
VM 移除 Lima 自有跳转/空链，初始化代码没有增加清理例外。

从 macOS 直接访问 VM 的 vzNAT 地址，22/80/443 成功，Docker 确实发布的8080/5432及5355
失败；没有用 Lima localhost forwarding 冒充外部端口证明。IPv6 公网路径未实测。

## 正式镜像与真实 reboot

`test-vm.py` 使用同版 bundle/deploy.sh，开启正式 backup override；独立 S3/TLS 测试夹具
不暴露数据端口。夹具挂载一份测试专用 S3 helper，正式应用没有源码挂载。
备份要求真实 base/dump/WAL verification 和成功 schedule slot，不能由进程存活代替。

第一次 reboot 的正式 PG/Valkey/web/jobs/Caddy/backup 自动启动，但 Debian 清理了放在
`/tmp` 的测试输入和报告，S3 TLS fixture 与任务 probe 没有启动。见
`first-reboot-fixture-failure.json`、`first-reboot-baseline.json`；不把这一轮记为完整验收成功。
修正后所有测试输入和报告使用 `/opt`，入口拒绝 `/tmp`；重新创建独立项目完成第二轮。

运行命令（仅在独占临时 VM 内，输入目录含脚本、bundle、backup helper）：

```sh
sudo python3 /opt/d-vm-input/test-vm.py --phase prepare \
  --bundle /opt/d-vm-input/bundle --evidence /opt/d-vm-results/runtime.json
# prepare 完成、任务 probe 已进入持久等待后，从宿主执行真正 reboot。
sudo systemctl reboot
sudo python3 /opt/d-vm-input/test-vm.py --phase after-reboot \
  --bundle /opt/d-vm-input/bundle --evidence /opt/d-vm-results/runtime.json
```

## B 补修与签收边界

正式版本把不同 PID namespace 当作旧进程退出，且同名异机的 boot 差异也可能放行。
旧 `.recovering` guard 在临界区退出后会永久阻塞。补修如下：

- Linux owner 记录可信宿主 machineId；缺身份或异机拒绝，同机 boot 变化才证明 reboot。
- 同 boot 不同 namespace 拒绝；Compose jobs 使用 host PID namespace 和只读宿主身份文件，
  保持稳定 executor/hostname、持久 owner 卷、非 root 和原资源/secret 边界。
- 初始化使用持续 pipe 持有的 OS flock，串行检查/定向清除可信已退出 guard；Node 真正
  exit 产生 EOF 释放内核锁。活/未知 guard 拒绝，持久锁文件和历史 owner 不删除。

`linux-ownership.json` 的15项 Linux 用例包含并发排他与真正 SIGKILL 后内核锁释放。
`linux-integration.json` 的3项真实 PG 用例覆盖 close 后旧进程仍活时拒绝、真实退出后恢复、
活/未知 guard 拒绝与可信 dead guard 恢复。这些使用正式 migrate 镜像的固定依赖，显式
只读挂载本 PR 的 B 源码；不能称为已经发布的新 jobs 镜像。

`test-vm-lifecycle.py` / `vm-lifecycle.mts` 只运行受控任务：成功 step 计数、持久 sleep、
带原 deadline 的 wait、显式事件与幂等完成。正式源码和补修源码分别使用独立 executor、
owner 卷与版本。它们不向外部 Provider、支付或邮件服务产生副作用。

旧 Linux owner 缺 machineId，补修会保守拒绝；没有自动改写旧记录或清空目录。
可信旧记录迁移、异机恢复退出证明仍需协调者另行签收。补修未进入固定正式 SHA，
不能用新源码 fixture 代签旧镜像。D 1.5、6.3、依赖1.5的2.1/2.3保持未勾选；第7组仍 BLOCKED。

## 发布门与检查

`mechanism.json`：VM 内8项隔离编排机制通过，包含 pull 失败保留旧应用、迁移失败阻止
目标启动、兼容回滚保留卷/marker、不兼容在变更前拒绝、并发发布串行。
正式 PG/DBOS、TLS、自然 heartbeat 与真实重启使用另一份 runtime 证据，不能混为同一结论。

`root-checks.json` 记录根检查、两目标构建与相关10/8/7项 Python用例；根 test 的26个任务
成功。Node 构建是本 PR 源码验证，没有作为正式发布。资源采样仅为轻量 fixture，不能
代签 B 1.9 或真实2核4GiB生产容量。最终清理结果单独记录。


## SSH、失败门与回滚补充

`runtime.json` 分阶段记录第二轮完整结果。SSH使用显式host/dir/完整SHA、BatchMode和真实
host key校验，传输后校验正式bundle并部署，持久卷不变、incoming目录已清理。
`ssh-first-failure.json`记录原SSH登录环境继承Lima代理后web探针无SHA而jobs SHA正确的
失败；测试VM限定NO_PROXY后原bundle通过。本PR入口修正让public_probe使用与Compose
相同的白名单环境；`proxy-probe.json`是在VM故意注入不可达代理后真实HTTPS成功的补修证据。

本地registry第二版只修改ENV/OCI revision、/version和编译产物完整SHA字面量，
`fixtureMetadataDiff`给出字节摘要，不包含B补修。升级保留真实业务/schema/roles/引擎记录
和卷；真实app角色作为migrator失败阻止目标web/jobs，真实不信任TLS导致readiness失败
保留上一成功记录；兼容回滚不重跑旧migration并保留数据、DBOS/任务状态与卷。
SSH阶段加入系统测试CA使首次本地“未知CA”负向断言失效，见`gates-first-failure.json`；
在gates移除仅本任务测试CA并刷新系统信任后重跑，未弱化TLS断言或修改正式应用。

正式生命周期报告中的`passed`表示脚本完成（包括成功复现漏洞），
`acceptancePassed=false`明确表示正式版本不能签收；补修报告为true，但仅限本机新记录。
两者不得混用。原始机密、连接串、私钥与响应正文均不进入证据目录。

## 最终清理

`cleanup.json`与runtime的cleanup阶段均通过：probe/S3/app/registry及所属卷网络已清除，
私有harness目录已移除。随后停止并删除`selfhost-d-vm`，Lima列表无该实例、磁盘目录不存在；
宿主临时fixture输入也已删除。本worktree与脱敏证据保留供PR审阅。

`rebased-checks.json`记录无冲突rebase至main `0bdb1cc` 后的全部根检查；
check/deps/singletons/dedupe/typecheck/test/build均为exit 0，test为26/26任务成功。
原VM/source fixture证据对应初始base `7e7c99c`，源码摘要见source-provenance，不冒充新正式发布。
