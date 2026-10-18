# D bundle 收尾与 registry 演练（2026-10-14）

发布来源：[run38573156122](https://github.com/ustclhx/product-res/actions/runs/38573156122)，
完整SHA `80983d29f83cb5b57563fc8360119793cf8c12be`，namespace `ghcr.io/ustclhx/product-res`。
该run与两架构smoke均成功。未触发selfhost-publish、未覆写任何正式SHA。

`image-set.json` 为成功artifact的语义等价副本（只经Biome排版），`bundle.json`记录从源SHA
Git对象生成的正式部署bundle、checksum及八服务digest；源SHA原17文件白名单不读工作树
.env/secret/证书或源码。bundle内原版verify与干净目录config通过。

`full-structure.json`是当前提交24项白名单的明确结构fixture：用原GHCR digest模拟image-set，
只验source-SHA取材/白名单/基础与全部可选override config，不冒充新正式镜像revision。
恢复/drill/replica与示例均齐，未来release会用其自己的同SHA镜像；当前正式SHA仍是原材料。

`root-checks.json`记录根验收。首次test因typecheck缓存未恢复ignored routeTree而两例失败，
实际typecheck --force生成后1511用例通过；check/deps/singletons/dedupe/typecheck/test/build
与OpenSpec strict通过。集成后补跑check/strict、7条bundle测试与9条deploy/health测试。

真实Compose演练由[只读CI](https://github.com/ustclhx/product-res/actions/runs/38583108140)执行，
成功，artifact含正式bundle和报告。`compose.json`与`failure-gates.jsonl`已下载并脱敏保存。它匿名读取registry，初始版本为GHCR正式SHA；第二版仅从预构建镜像派生
SHA/OCI revision元数据fixture，不改变业务/schema/handler。自然五分钟heartbeat与真实
终态DBOS记录是状态证据，不插入人工引擎状态或伪造心跳。inbox为空时如实列出。

B/D1.5未签收；未完成任务恢复、异机退出/宿主reboot/完整备份成功均未验证。
第7组等待真实主机/入口/独立存储/重启资源；没有连接真实服务器或修改CF staging，
不代勾A/B/C。1.4完整bundle正式发布验收仍待后续受信SHA，不覆写已发布版本。


真实结果：GHCR源SHA → 本地metadata fixture
`e23d1292b77d762ba7f29f0b666b226d08f3e5f2` → 角色迁移失败 → HTTPS检查失败 → GHCR回滚。
真实自然heartbeat产生2条completed schedule_run、2条SUCCESS DBOS workflow及2条operation
checkpoint，5个schedule定义保留；578列schema、三角色元数据和所有命名卷保持。回滚
未重建/执行旧migrate。业务表与message inbox为空，不能宣称非空业务恢复或待处理任务
重新执行。fixture逐文件hash证明只改固化完整SHA，未更改业务/schema/handler。

root权限只用于隔离CI宿主80/443预检与0600文件UID装配，应用/数据库/代理始终原非root
用户；临时资源清理成功。初次普通runner预检失败时未启动应用，修正后成功。
本机Docker Desktop首个web pull900秒超时（`local-pull.json`），随后按任务要求改用CI，
只结束自己启动的pull进程，没有更改桌面代理或其他容器。

本PR另一路镜像smoke的arm64在`test-backup.mjs`失败；包装器未提供详细诊断，当前未改
backup业务代码，不将此结果列为备份通过。首次正式发布的原SHA两架构smoke均成功。
所有根/Node/e2e/关闭功能/部署机制CI已通过；镜像矩阵结果单列`ci.json`供协调者及backup
owner复核，第6.4与backup/server签收不在本任务勾选范围。

最终`compose.json`含三阶段各服务实际UID、状态/退出码、digest、网络/宿主映射与secret名称，
没有environment正文、secret值或owner token。PG/Valkey999，web/jobs/migrate1000，Caddy10001；
常驻均running，迁移exited(0)，数据服务无宿主端口。全部临时资源清理成功。
