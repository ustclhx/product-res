# PR #240 中断复制回归补正

初版提交`5a087ca3d292bf3a9c1831b50710db2db92018b4`引入真实回归：
[arm64 CI](https://github.com/ustclhx/product-res/actions/runs/39043002791/job/117426099365)
在`phase=replica_sync`失败，原断言为`Interrupted copy reported success`。
amd64 [同样失败](https://github.com/ustclhx/product-res/actions/runs/39043002791/job/117426099126)。
原冒烟用`timeout --signal=KILL 1 ... replica-sync`中断复制，要求命令非零且
`status().replica.ok=false`。本次没有修改`test-backup.mjs`或任何冒烟期望。

## 原因与补正

初版`operation('replica', ...)`在新复制开始时沿用了上一轮`ok=true`。
SIGKILL不能被Python异常处理捕获，因此无法执行失败分支，新复制尚未完成时仍残留
`ok=true`。先前基于抛出BackupError的测试只能覆盖可捕获异常，漏掉了进程硬中断。
这与socket的30秒超时或日志输出没有关系，属于状态判定回归。

现在每次复制开始就写`ok=false`，只有本次manifest提交和内容校验全部完成后才置true。
健康检查仍可在活跃刷新中使用旧证明，但必须同时满足：本轮从成功状态开始、旧证明
仍在原新鲜度预算内、复制进程实际持有`replica.lock`排他锁。
状态与retention的成功判定不使用此健康例外。SIGKILL/crash由内核释放锁，残留
`running=true`不能证明进程还在；失败后的重试也不能借上次成功放行。
健康读取用非阻塞共享锁探测，多个health读取不会互相冒充活跃复制。
不使用PID、TTL或时间推测进程存活。

## 回归测试

先在初版运行：

```sh
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover \
  -s deploy/selfhost/backup -p replica_test.py -k killed -v
```

结果为`FAIL: True is not false : Interrupted copy reported success`。
测试启动真实子进程，在复制进入执行后发送SIGKILL，等待确认退出；没有mock信号或异常。
补正后该用例通过，确认退出码非零、ok=false、旧成功时间/manifest未被改写、health失败。
另验证残留running和另一个operation.lock均不能冒充活跃复制。

现有socket超时用例扩展到真实`S3.request → operation`调用链，确认超时抛出固定错误码、
状态ok=false/running=false、旧manifest不变、日志脱敏，30秒socket超时保持不变。

`PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s deploy/selfhost/backup -p '*test*.py'`：
33项通过；相同33项也在现有backup镜像内的Linux/arm64 Python运行时通过。
`pnpm check`通过；`pnpm typecheck`14/14通过（缓存）。

## 本地原冒烟与交付边界

使用本机arm64已有`598d1f68b6ef7b19e8a6d30c13575bac1701b7c2`的PG/backup/migrate/
object-storage镜像，运行原`test-backup.mjs --restore --dev-runtime`。
当前Python通过只读挂载装配到独立随机project，无宿主端口、仅internal网络。
这是本地源码夹具验证，不是新的正式镜像或release验收。

原冒烟整轮通过，`passed=true`、`cleaned=true`；`replica.sync.interruptedResumed=true`，
目标故障非零、主归档独立、故障恢复、源删除不传播、仅副本同点恢复均通过。
原中断断言未改；源码/冒烟SHA256及脱敏摘要见[冒烟证据](ci-correction-smoke.json)。
没有连接测试主机，没有修改既有服务、配置、对象或卷。
推送后交协调者等待images amd64/arm64等CI全部通过，再决定发布；本worker不合并或发布。
