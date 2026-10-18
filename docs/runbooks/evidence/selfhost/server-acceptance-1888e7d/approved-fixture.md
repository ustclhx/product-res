# 已批准的 sleep 夹具修正

协调者于本轮明确批准：将 `packages/platform/test/node/workflow.integration.test.ts`
的 graceful drain 用例初始 `sleepMs` 从 `2_000` 改为 `5_000`，已正式提交到 PR #238，
提交 `e5cdd87`。该测试需要在 workflow 仍 sleep 时重启引擎；2 CPU 主机冷启动耗时
超过原 2 秒 sleep，导致恢复完成时已经越过原 deadline + 1000ms 上界。

全部原断言保留：PENDING 状态、原 checkpoint 内容、原 deadline 下界及 +1000ms 上界、
成功 callback 计数、checkpoint 前崩溃后的重试次数和业务副作用只发生一次。
未修改引擎、deadline、时钟、测试超时或已发布 bundle。

复验使用正式 `1888e7d165b0b87784e7d16a4c39709a9bc063e3` migration 镜像，
仅把上述测试文件只读挂载到镜像内原路径；这不是新的正式发布，也不冒称旧镜像原含此修正。
服务仍运行同 SHA 正式 image-set。[复验10个短用例全部通过](workflow-approved-fast.json)，原版61分钟长用例独立通过；分别保留报告，不合成为一次全量运行。完整覆盖说明见[分次验收](workflow-acceptance.json)。

此前 `UNEXPECTED_MISSING_EXISTING_CONTAINER` 是检查器错误：它遍历了全部历史停机 TSV，
其中包含协调者此前已获准删除的 pilot 容器，且不同批次记录格式不同，不能据此推断当前容器缺失。
后续格式过滤也未完全解决历史记录解析；未确定每条错误历史行，不推测某个实际容器被删除。
最终改用部署前记录的 15 个实际存在容器作为基线，逐一直接 inspect，要求存在、exited、restart=no。
15 个均通过，warp 保持 inactive/disabled。没有重新创建或启动任何非 selfhost 容器，原 TSV 保留。
reboot 前后检查也使用这份相同基线，并比较容器身份与 StartedAt 的哈希指纹。
