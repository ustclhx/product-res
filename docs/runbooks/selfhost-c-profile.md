# C 1.5/1.6：object-storage profile 与全栈验收

本批仅交付默认关闭的 SeaweedFS Community 4.48 Compose override、初始化/代理配置与本机验收脚本；不修改 S3 adapter、Node入口、B媒体 Workflow、D发布/服务器/备份，未连接ECS或部署staging。

## 配置与证据范围

生产操作见 [selfhost README](../../deploy/selfhost/README.md#可选-object-storagec-1516)。上游固定 manifest `sha256:4e61d15fd35994cb1e43e1e553dff106794841fd9a99ade2fc8c8bfce4d7872d`，重新核验 linux/amd64、linux/arm64 均存在；本次实际运行 arm64，manifest复核不冒称实际跑过amd64。

关闭profile时只加载基础Compose，不需要object-storage镜像、域名、bucket或四份S3 secrets；config验证时特意删除所有S3变量，并指向未创建的secret目录。开启需显式加载第二份env/Compose文件与object-storage profile。基础Compose和外部S3默认资源限额均未修改。

非rootwrapper在监听前读取四份file secrets，生成tmpfs认证JSON；admin与指定bucket应用身份分开，私有桶无匿名策略。SeaweedFS 4.48的bucket Write包括CORS/lifecycle/versioning等管理操作，不能仅靠无Admin action宣称权限隔离。公开代理拒绝bucket根PUT/POST/DELETE；只有bootstrap在object私有网直连管理。对象服务和代理不接PG data网，web/jobs不接object网；仅代理发布80/443。上游mini内部维护/管理组件是必需部分，管理UI/WebDAV/IAM/Iceberg/Lance关闭，控制端口未发布。

Caddy profile以UID10001/cap_drop ALL及namespace内低端口sysctl监听443；S3公开域名在ingress解析到它，Node和浏览器访问同一HTTPS端点。jobs固定独立IP，避免先启动的动态地址占用Caddy的固定IP。代理保留签名Host/path/query；S3错误handler返回固定503，避免默认错误日志携带request URI。实际故障签名请求与日志检查也是验收的一部分。

## 可重复的本机验收

```sh
node deploy/selfhost/test-object-storage.mjs
# 同一当前完整SHA的本机验收镜像已经构建时，可复用：
node deploy/selfhost/test-object-storage.mjs --reuse-images
```

脚本使用仓库外0700临时目录、自签CA和随机本次凭据，Docker容器/网络/卷均带selfhost-c-profile名称。只操作自己创建的资源，成功/失败/SIGINT/SIGTERM均清理本次容器、卷、网络与临时秘密。验收镜像留在本机，不推送，不清理其他任务的镜像/缓存。

应用使用A的正式Dockerfiles与生产入口，完整SHA固化；只在临时跟踪文件副本中关闭Turnstile/OAuth，保留邮箱密码注册与个人空间，workspace由真实HTTP注册产生。临时副本另补入C的`scripts/sentry-node-maps.mjs`构建输入：现有A Dockerignore尚未包含该新脚本，未经此补入的现有build.sh会MODULE_NOT_FOUND。这是已记录的D/A镜像接线缺口，工作区Dockerfile/ignore未修改；本次本地镜像成功不等于D正式镜像构建/发布通过。

Chromium客户端在独立Linux Playwright1.63.0容器运行，使用固定官方镜像digest，在短命pwuser NSS数据库导入本次CA。host用项目现有Playwright连接run-server，`ignoreHTTPSErrors:false`，没有忽略证书错误、关闭WebSecurity或改宿主keychain。实现依据[Chromium NSS文档](https://chromium.googlesource.com/chromium/src/+/master/docs/linux/cert_management.md)与[Playwright远程Docker文档](https://playwright.dev/docs/docker)。浏览器、构建与已有本机PG属于外部测试driver/背景，独立于被测服务器栈。

协议链路在APP_URL页面执行真实注册/会话、声明上传、条件PUT、确认、attachment下载；CDP观察浏览器自己的OPTIONS。签名HEAD由临时helper使用同一应用配置签HeadObjectCommand，不把GET签名改成HEAD，不扩展Storage接口。另一HTTPS页面真正发跨origin请求，浏览器拒绝；没有伪造Origin或拦截网络。重复PUT412、原内容保持，匿名GET403，签入的Content-Type/If-None-Match和暴露ETag/长度均经过实际浏览器。

未知长度测试只读挂载单独编译的现有copier helper到真实jobs容器，在该512MiB cgroup内执行；原jobs/DBOS/Cron同时运行。两路各64MiB，每次pull64KiB、无Content-Length、不预分配全量文件，沿现有binary ReadableStream契约、5MiB part/queueSize1；验证返回实际大小与HEAD一致并删除。这不代表B媒体工作流已移植或外部HTTPS白名单已由本批重新验收。

维护用HTTP创建并PUT八份pending对象，仅在本次独占数据库回溯这些fixture记录的created_at，等待真实下一UTC十分钟Cron，不手调handler、不伪造heartbeat；确认正式cron.files-cleanup日志、记录和对象都消失。随后真实restart与保留卷down/up验证对象仍在、非root和完整readiness；最终才down -v销毁验收数据。

## 资源预算与测量

初始设计与最终预算：PG1024、Valkey384、web768、jobs512、Caddy128、storage512MiB，合计**3328MiB/2CPU**，按4GiB预算保留768MiB。最终没有增加总配额；补充了Go384MiB目标/GOMAXPROCS1、LevelDB索引、128MiB卷、storage/filer并发参数2与32MiB上传预算。Go目标不是硬限额，Docker才是硬边界；数据库迁移与幂等bucket初始化在应用启动前执行。

本机Docker VM实际10CPU/约7.65GiB，本次按Compose六个常驻服务的CPU硬配额合计2CPU、内存硬上限合计3328MiB模拟服务器预算。不是在真实2核4GiBECS上运行。浏览器driver及已有本地PG单独统计，不计入服务器预算；真实主机OS/Docker等开销仍属于D部署验收。

DockerEngine stats每约500ms采样全部被测容器：usage包含页缓存，working set=usage-inactive_file，RSS采用cgroup anon，CPU采用累计usage增量/实际时间（1核=100%）。重启/重建采用异步命令保持采样；每个资源阶段必须有六个常驻服务样本。各次重启/重建前后读memory.peak/memory.events/cpu.max并查运行状态/RestartCount，防止重建擦除此前OOM记录。PG连接数同步记录。样本的同一时刻栈总峰值与各服务自身cgroup峰值区别保留，不能把各服务不同时间的峰值加和称同一时刻峰值。

最终验收应用镜像版本为 `e69bd2d160c07bb4f56b040524ad1242976de91a`；profile文件与最终脚本使用本分支内容。实际UTC十分钟维护为 `2026-10-13T07:40:00Z`，readiness的成功heartbeat见原始结果。

| 场景 | 样本数 | usage峰值 MiB | working set峰值 MiB | RSS峰值 MiB | CPU峰值 核 | CPU平均 核 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 空卷启动 | 66 | 304.25 | 252.22 | 208.36 | 0.602 | 0.132 |
| idle（30秒） | 57 | 313.79 | 261.58 | 214.18 | 0.234 | 0.090 |
| 4路上传 × 3轮 | 10 | 636.20 | 410.30 | 352.69 | 0.556 | 0.427 |
| 2路未知长度转存 | 21 | 736.32 | 494.07 | 429.48 | 0.713 | 0.294 |
| 自然Cron/维护 | 459 | 651.34 | 400.64 | 344.71 | 0.464 | 0.088 |
| restart/down-up | 108 | 399.61 | 349.37 | 300.38 | 0.602 | 0.120 |

最大实测usage **736.32MiB**，占4GiB预算约18.0%，相对4GiB剩余3359.68MiB；相对3328MiB服务限额剩余2591.68MiB。CPU峰值0.713核，2核余量1.287核。各服务原始cgroup峰值、CPU配额、OOM/运行状态检查及PG连接数（最高15）见[原始结果](selfhost-c-profile-resources.json)。所有检查均 `oom_kill=0`、没有意外restart；最终 `profile.passed` 与 `profile.cleaned`。

浏览器driver在独立容器，单次旁观Docker stats工作集约976MiB；已有本机PG约66MiB，均未纳入服务器栈表。Docker VM不是4GiB物理主机，上述余量不代替D的OS/daemon/服务器实测。

测试入口修正记录：初次基础构建缺maps输入；profile jobs动态IP与代理固定IP冲突；Compose对显式一次性target使用--wait会把exit0当失败，改为等待实际退出码；Docker重启CPU计数归零，统计增量截断为0；保留卷重建后旧浏览器连接曾Failed to fetch，最终明确reload页面重建连接再验证。未修改adapter/入口、未放宽业务状态/数据断言。

验收并发边界为分别**4路16MiB浏览器上传**（3轮）和**2路64MiB未知长度copier**。只支持本次数据量与场景的实测结论；未穷尽更大并发、持续海量对象/索引或两组负载同时叠加，不承诺任意吞吐或HA。

## PR检查与后续边界

根check/deps/singletons/dedupe/typecheck/test/build均通过；typecheck14/14，rebase后根test26/26任务、175文件/1293用例（22任务缓存），默认CF build2/2（最终有效缓存；初轮实跑18页预渲染/jobs dry-run）。Node web/jobs在本机验收镜像构建中执行pnpm build:node并离线注入maps，18页无部署凭据预渲染通过。rebase main `ba8f27b`（#143，CF/fal修复）后，全部根门槛及host `pnpm build:node`重新验证，Node两输出2/2实跑且离线inject通过；profile与Node S3 adapter/入口没有变化。OpenSpec strict与新增shell/Node/Biome检查通过。独立核验发现并补修代理错误日志、动态IP冲突和采样覆盖/OOM检查，未削弱业务断言或改第三方adapter。

只勾选有本次完整证据的C1.5/1.6。C1.7外部R2/第二端点、真实Sentry源码映射、SMTP认证邮件、C4.x及B/D任务不在本批；不同步/归档change、不自行合并PR。profile关闭不复制或删除既有卷，迁移endpoint与备份恢复仍需部署方单独安排。
